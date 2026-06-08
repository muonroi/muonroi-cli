/**
 * src/orchestrator/tool-loop-cap.ts
 *
 * Pure factory for the AI-SDK `stopWhen` predicate that backs two related
 * "agent is going off the rails" guards:
 *
 *  1. **Cap guard** — when the streamText loop hits the cap, ask the user
 *     whether to bump the cap (+50 default) or stop.
 *  2. **Pattern guard (Fix #1)** — when the last 5 tool calls have ≥ 3 with
 *     the same canonical args hash (e.g. agent ran `bunx vitest | tail -5`,
 *     `bunx vitest | head -10`, `bunx vitest | grep FAIL` in a row), ask
 *     the user whether to continue or stop *before* the cap runs out.
 *
 * Both guards are surfaced through the same `ask` callback using a tagged
 * union (`kind: "cap" | "pattern"`) so callers can route to the right askcard
 * phase. The pattern guard fires at most once per session — a single trip is
 * enough to break the loop; firing repeatedly would be noise.
 *
 * Extracted from message-processor.ts so we can unit-test the algorithm
 * without standing up a full streamText harness.
 */

import { hashToolArgs } from "./tool-args-hash.js";

export type ToolLoopCapAskInfo =
  | { kind: "cap"; stepNumber: number; cap: number; bumpBy: number }
  | {
      kind: "pattern";
      toolName: string;
      count: number;
      windowSize: number;
      /** Step count at the time the pattern fired — drives default-action heuristic. */
      stepNumber: number;
      /** Resolved natural ceiling for the current (taskType, size). Optional — undefined when caller can't compute it. */
      naturalCeiling?: number;
    };

export type ToolLoopCapAsk = (info: ToolLoopCapAskInfo) => Promise<"continue" | "stop">;

export interface ToolLoopCapOptions {
  initialCap: number;
  bumpBy?: number;
  ask?: ToolLoopCapAsk;
  /** Override defaults — exposed for tests. */
  patternWindow?: number;
  patternThreshold?: number;
  /**
   * Natural step ceiling for the current (taskType, size). Passed to the ask
   * handler so the askcard UI can pick a context-aware defaultIndex (continue
   * early, stop late).
   */
  naturalCeiling?: number;
}

export const DEFAULT_TOOL_LOOP_BUMP = 50;
export const DEFAULT_PATTERN_WINDOW = 5;
export const DEFAULT_PATTERN_THRESHOLD = 3;

// Minimal shape we need from an AI-SDK step. Kept loose because the SDK's
// step type is generic over toolset and we don't want to fight types here.
interface MinimalStep {
  toolCalls?: ReadonlyArray<{ toolName?: string; input?: unknown; args?: unknown }>;
}

/**
 * Hash an entire step (all tool calls in order) so two parallel reads of
 * different files don't collide just because the first-positional call
 * happens to be identical. Phase 5 BUG-G (session f1a2a2a547db) — agent
 * issued 3 parallel-style steps reading layer16-clarity.ts + its test file;
 * detecting only `toolCalls[0]` hashed all 3 to the same value and tripped
 * the loop guard even though step-2 and step-4 also touched the test file.
 *
 * Skips `verify:` sentinel hashes — verification commands MUST NOT count
 * toward the pattern window (they're iteration markers, not loop signal).
 *
 * Returns null when the step has no usable tool calls.
 */
function hashStep(step: MinimalStep | undefined): { hash: string; toolName: string } | null {
  if (!step?.toolCalls?.length) return null;
  const parts: string[] = [];
  for (const tc of step.toolCalls) {
    if (!tc?.toolName) continue;
    const argsCandidate = tc.input !== undefined ? tc.input : tc.args;
    const h = hashToolArgs(tc.toolName, argsCandidate);
    // Verification calls — drop entirely from the step signature so they
    // can't cause repeated edit+typecheck cycles to look identical.
    if (h.startsWith("verify:")) continue;
    parts.push(h);
  }
  if (parts.length === 0) return null;
  const firstToolName = step.toolCalls.find((tc) => tc?.toolName)?.toolName ?? "unknown";
  // Join with `|` — order-sensitive on purpose: a step doing [read A, read B]
  // is distinct from [read B, read A] in tool-emission order, so collapsing
  // them risks hiding a real loop where the agent reorders calls.
  return { hash: parts.join("|"), toolName: firstToolName };
}

/**
 * Build the async stopWhen predicate.
 *
 *   - Pattern dup ≥ threshold in window → ask("pattern"); fire-once per session
 *   - `sn < cap`                        → false (keep going)
 *   - cap hit, no `ask`                 → true  (legacy hard-stop, batch / headless)
 *   - cap hit, ask=continue             → bump cap by `bumpBy`, return false
 *   - cap hit, ask=stop                 → true  (graceful halt)
 */
export function createToolLoopCapPredicate(
  opts: ToolLoopCapOptions,
): (state: { steps: ReadonlyArray<unknown> }) => Promise<boolean> {
  let cap = opts.initialCap;
  const bumpBy = opts.bumpBy ?? DEFAULT_TOOL_LOOP_BUMP;
  const ask = opts.ask;
  const patternWindow = opts.patternWindow ?? DEFAULT_PATTERN_WINDOW;
  const patternThreshold = opts.patternThreshold ?? DEFAULT_PATTERN_THRESHOLD;

  // Pattern detector state — one-shot per session to avoid asking again after
  // the user said "continue". The cap guard still catches the loop later.
  const recent: { hash: string; toolName: string }[] = [];
  let patternAskFired = false;
  let lastSeenStepCount = 0;

  return async ({ steps }) => {
    const sn = steps.length;

    // Pattern detector — examine the most recently-added step's tool calls.
    // streamText calls stopWhen between steps, so `steps[sn-1]` is the step
    // that just finished. Multiple stopWhen invocations may pass the same
    // step length (e.g. compaction reruns); only process new growth.
    if (ask && !patternAskFired && sn > lastSeenStepCount) {
      lastSeenStepCount = sn;
      const lastStep = steps[sn - 1] as MinimalStep | undefined;
      const stepSig = hashStep(lastStep);
      if (stepSig) {
        // File edits (edit_file / write_file) are normal productive refinement on the same target.
        // Do not let repeated edits on one file contribute to pattern-loop detection.
        // This prevents false-positive stop warnings during legitimate iterative work
        // (e.g. session df2dbb878984 and similar "edit same file 3x" flows).
        // The max-tool-rounds cap still protects against true runaway loops.
        if (stepSig.toolName === "edit_file" || stepSig.toolName === "write_file") {
          // skip pattern accounting for fs edits
        } else {
          recent.push(stepSig);
          if (recent.length > patternWindow) recent.shift();
          const dupCount = recent.filter((r) => r.hash === stepSig.hash).length;
          if (dupCount >= patternThreshold) {
            patternAskFired = true; // one-shot regardless of verdict
            const verdict = await ask({
              kind: "pattern",
              toolName: stepSig.toolName,
              count: dupCount,
              windowSize: recent.length,
              stepNumber: sn,
              naturalCeiling: opts.naturalCeiling,
            });
            if (verdict === "stop") return true;
            // Continue → clear the ring so we don't immediately re-fire on the
            // next call (user explicitly accepted; give them breathing room).
            recent.length = 0;
          }
        }
      }
    }

    // Cap guard — unchanged behaviour.
    if (sn < cap) return false;
    if (!ask) return true;
    const verdict = await ask({ kind: "cap", stepNumber: sn, cap, bumpBy });
    if (verdict === "continue") {
      cap += bumpBy;
      return false;
    }
    return true;
  };
}
