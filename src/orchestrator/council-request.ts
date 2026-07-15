/**
 * src/orchestrator/council-request.ts
 *
 * Process-global one-shot channel for an AGENT-initiated council convening.
 *
 * The `convene_council` tool (src/tools/registry.ts) sets a pending request when
 * the model decides THIS request warrants a multi-model debate; the tool-engine
 * consumes it from the OUTER restart loop after a stream drain (NOT solely via
 * dynamicStopWhen — a phase-1 SAMR step ends on stepCountIs(1) and never
 * evaluates the stop hook), runs `runCouncilV2({ convenePath: true })`, splices
 * the synthesis into the convene tool's tool_result, and restarts streamText so
 * the model reads the conclusion as the tool's result and continues the turn.
 *
 * Modelled on compact-request.ts. Two differences that matter for correctness:
 *   1. It carries the `toolCallId` of the convene_council call so the tool-engine
 *      can (a) confirm the pending request actually belongs to THIS drain's
 *      messages before running council — guarding against a nested sub-session
 *      whose convene call would otherwise be consumed by the parent loop — and
 *      (b) locate the exact tool-result to replace with the synthesis.
 *   2. `peekCouncilConveneToolCallId()` is a NON-consuming read for that guard;
 *      the flag is only cleared by `consumeCouncilConvene()` (on run) or by the
 *      turn-teardown `finally` (discard) so a request can never leak into the
 *      next user turn when the convene call shared a step with a terminal
 *      `respond_*` tool.
 *
 * Single-active-turn assumption (inherited from compact-request.ts): the TUI
 * streams one turn at a time, so a process-global slot cannot cross-talk between
 * concurrent user turns.
 */

export interface CouncilConveneRequestState {
  /** Model-supplied justification for convening (the specific tradeoff/decision at stake). */
  reason: string | null;
  /** Tool-call id of the convene_council call, so the tool-engine can match + replace its result. */
  toolCallId: string | null;
}

let pending: CouncilConveneRequestState | null = null;

/** Queue a council convening to run before the model's next step. */
export function requestCouncilConvene(reason?: string | null, toolCallId?: string | null): void {
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  const trimmedId = typeof toolCallId === "string" ? toolCallId.trim() : "";
  pending = {
    reason: trimmedReason.length > 0 ? trimmedReason : null,
    toolCallId: trimmedId.length > 0 ? trimmedId : null,
  };
}

/** True when a council convening is queued (non-consuming peek). */
export function hasPendingCouncilConvene(): boolean {
  return pending !== null;
}

/**
 * Non-consuming read of the pending request's toolCallId. Used by the tool-engine
 * to check whether the pending convene belongs to THIS drain's response.messages
 * before committing to a (possibly expensive, possibly wrong-frame) debate.
 */
export function peekCouncilConveneToolCallId(): string | null {
  return pending?.toolCallId ?? null;
}

/** Consume the pending request exactly once (returns null when none queued). */
export function consumeCouncilConvene(): CouncilConveneRequestState | null {
  const p = pending;
  pending = null;
  return p;
}

/** Test hook — clear any queued request. */
export function __resetCouncilConveneForTests(): void {
  pending = null;
}
