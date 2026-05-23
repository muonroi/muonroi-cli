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
  | { kind: "pattern"; toolName: string; count: number; windowSize: number };

export type ToolLoopCapAsk = (info: ToolLoopCapAskInfo) => Promise<"continue" | "stop">;

export interface ToolLoopCapOptions {
  initialCap: number;
  bumpBy?: number;
  ask?: ToolLoopCapAsk;
  /** Override defaults — exposed for tests. */
  patternWindow?: number;
  patternThreshold?: number;
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
      const tc = lastStep?.toolCalls?.[0];
      if (tc?.toolName) {
        const argsCandidate = tc.input !== undefined ? tc.input : tc.args;
        const hash = hashToolArgs(tc.toolName, argsCandidate);
        recent.push({ hash, toolName: tc.toolName });
        if (recent.length > patternWindow) recent.shift();
        const dupCount = recent.filter((r) => r.hash === hash).length;
        if (dupCount >= patternThreshold) {
          patternAskFired = true; // one-shot regardless of verdict
          const verdict = await ask({
            kind: "pattern",
            toolName: tc.toolName,
            count: dupCount,
            windowSize: recent.length,
          });
          if (verdict === "stop") return true;
          // Continue → clear the ring so we don't immediately re-fire on the
          // next call (user explicitly accepted; give them breathing room).
          recent.length = 0;
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
