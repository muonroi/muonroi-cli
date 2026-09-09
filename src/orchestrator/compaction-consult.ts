/**
 * src/orchestrator/compaction-consult.ts
 *
 * C3 — ask the MAIN-CONTEXT agent before an automatic compaction runs.
 *
 * Why this exists
 * ---------------
 * An automatic compaction used to happen TO the agent, never WITH it. The
 * per-step compactor (`compactSubAgentMessages`, driven from tool-engine.ts)
 * rewrote older tool results into stubs on its own schedule, and the
 * summarizing compaction (`Orchestrator.compactForContext`) asked a DIFFERENT
 * model (`proposeCompaction`) — one that only sees a serialized transcript and
 * cannot know which files the working agent still needs open. Measured harm:
 * `interaction_logs` id=6313, session e28336959a62, 2026-09-09T02:30:54.991Z,
 * `{"tokensBefore":61472,"tokensAfter":24470,"saved":37002,"pct":"60.2"}` — the
 * agent had to re-read the files it was working on immediately afterwards.
 *
 * What this module decides
 * ------------------------
 * A single pure function. Given "would an automatic compaction elide something
 * on this step?" plus the current context-window headroom, it returns either:
 *
 *   - `defer`          — inject a note asking the agent to state a focus, and
 *                        SKIP the compaction for exactly this one step. Safe
 *                        only while there is real headroom.
 *   - `ask-and-compact`— there is not enough headroom to spend a step waiting,
 *                        so the compaction runs NOW and the note tells the agent
 *                        it already happened (no false promise).
 *   - `null`           — no consult: nothing would be compacted, the agent has
 *                        already stated a focus, or we already asked this turn.
 *
 * Safety
 * ------
 * Deferring costs one extra step at un-compacted size, so it is gated on
 * `G2_FIRST_ESCALATION_FILL` (0.6) — the fill ratio at which the compactor's own
 * `computeDynamicParams` FIRST starts shrinking the verbatim keep window, i.e.
 * the first point the existing code judges the window to be tightening. Below
 * it the compactor still considers its default keep window safe, leaving ≥40% of
 * the window as headroom for the single deferred step. An unknown context window
 * (`contextWindowTokens <= 0`) is treated as NO headroom — never as plenty.
 *
 * Ask-once-per-turn is enforced by the caller passing `alreadyAsked`; the flag
 * lives in the same per-turn closure as the compaction hysteresis state. That
 * is deliberate: the prior art at subagent-compactor.ts (the identity contract
 * comment) records exactly this bug class — a note that fires on every step.
 */

import { G2_FIRST_ESCALATION_FILL } from "./subagent-compactor.js";

export type CompactionConsultAction = "defer" | "ask-and-compact";

export interface CompactionConsultDecision {
  action: CompactionConsultAction;
  /** The system note to inject into this step. */
  note: string;
  /** Fill ratio used for the decision (0 when the window is unknown). */
  ctxFill: number;
}

export interface CompactionConsultInput {
  /** From `estimateCompactionPressure(...).wouldCompact`. */
  wouldCompact: boolean;
  /** True when a consult note was already injected earlier in THIS turn. */
  alreadyAsked: boolean;
  /** The focus the agent already stated this turn, or null when it has not spoken. */
  agentFocus: string | null;
  /** From `estimateCompactionPressure(...).ctxFill` — 0 when the window is unknown. */
  ctxFill: number;
  /** Model context window in tokens; 0/unknown disables deferral. */
  contextWindowTokens: number;
  /** From `estimateCompactionPressure(...).estPromptTokens`. */
  estPromptTokens: number;
  /** Current step number, for the note text. */
  stepNumber: number;
  /** Override the headroom line (tests). Defaults to G2_FIRST_ESCALATION_FILL. */
  maxFillRatio?: number;
}

/** How the agent is told to answer. Kept identical in both note variants. */
const ANSWER_INSTRUCTION =
  "Decide now: call the `compact` tool with a `focus` naming exactly what must survive — files and line ranges, error states, and the current sub-task. Whatever you name is honoured: matching tool results are kept verbatim instead of stubbed, and the focus is handed to the summarizing compaction too. Say nothing and an automatic compression runs with default rules. Do not stop or re-plan the task on account of this message.";

export function evaluateCompactionConsult(input: CompactionConsultInput): CompactionConsultDecision | null {
  const { wouldCompact, alreadyAsked, agentFocus, ctxFill, contextWindowTokens, estPromptTokens, stepNumber } = input;
  const maxFillRatio = input.maxFillRatio ?? G2_FIRST_ESCALATION_FILL;

  // Nothing to consult about.
  if (!wouldCompact) return null;
  // The agent already said how it wants this handled — honour it, do not nag.
  if (agentFocus && agentFocus.trim().length > 0) return null;
  // At most once per turn.
  if (alreadyAsked) return null;

  const knownWindow = contextWindowTokens > 0 && ctxFill > 0;
  const tokens = Math.round(estPromptTokens);
  const sizeText = knownWindow
    ? `~${Math.round(ctxFill * 100)}% of this model's context window (~${tokens} of ${contextWindowTokens} tokens)`
    : `~${tokens} estimated prompt tokens (this model's context window is unknown here)`;

  // Deferral is only safe with real, KNOWN headroom.
  const canDefer = knownWindow && ctxFill < maxFillRatio;

  if (canDefer) {
    return {
      action: "defer",
      ctxFill,
      note: `[auto-compaction consult — step ${stepNumber}] The prompt is at ${sizeText}. History will be compressed before your NEXT step, not this one — this step is yours. ${ANSWER_INSTRUCTION}`,
    };
  }

  return {
    action: "ask-and-compact",
    ctxFill,
    note: `[auto-compaction notice — step ${stepNumber}] The prompt reached ${sizeText}, past the ${Math.round(maxFillRatio * 100)}% line where deferring a compaction by one step would risk overflowing the window — so history was compressed THIS step, already. Older tool results are now stubs; rehydrate any you still need with ee_query "tool-artifact id=…". ${ANSWER_INSTRUCTION}`,
  };
}

/**
 * C2 — instruction text for the SUMMARIZING compaction
 * (`generateCompactionSummary`, driven from `Orchestrator.compactForContext`).
 *
 * That path runs a different model over a serialized transcript, so it has no
 * way to know which files the working agent still needs open. This composes the
 * two things it must be told, in priority order, and MERGES them — the agent's
 * focus never replaces the sub-session instruction, and vice versa.
 *
 * Returns `undefined` when there is nothing to say, which is exactly the value
 * `compactForContext` passed before this existed — so the no-focus,
 * no-sub-session path is byte-identical to the old behaviour.
 */
export const SUB_SESSION_COMPACTION_INSTRUCTION =
  "This is a temporary sub-session. Under sub-sessions, it is CRITICAL to preserve active files being worked on, compiler/linter error states, and exact line coordinates in the summary. Do not omit details of files edited, tests run, or compiler diagnostics, as the model needs this specific context to continue working without re-reading the files.";

export function buildCompactionCustomInstructions(args: {
  isSubSession: boolean;
  agentFocus: string | null;
}): string | undefined {
  const parts: string[] = [];
  if (args.isSubSession) parts.push(SUB_SESSION_COMPACTION_INSTRUCTION);
  const focus = typeof args.agentFocus === "string" ? args.agentFocus.trim() : "";
  if (focus.length > 0) {
    parts.push(
      "The agent working in this context was consulted and stated exactly what must survive this compaction. " +
        "Treat the following as a hard requirement: reproduce this content in the summary in full detail " +
        "(file paths with line ranges, error/diagnostic text verbatim, and the current sub-task), so the agent " +
        `does not have to re-read anything. AGENT PRESERVATION FOCUS: ${focus}`,
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
