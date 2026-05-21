/**
 * src/ee/phase-tracker.ts
 *
 * P1 Item 3 wiring: in-memory phase tracker.
 *
 * Aggregates the runtime signals (principles fired, verifier outcomes, abort
 * events) for the *current* GSD phase. The orchestrator calls `setPhase()`
 * at every user-turn boundary; when the phase changes from a non-null prior
 * phase, the tracker drains a snapshot the orchestrator forwards to
 * `firePhaseOutcome`.
 *
 * Why a singleton: the hook layer surfaces principle IDs at PreToolUse and
 * verify outcomes at PostToolUse. The orchestrator only sees turn boundaries.
 * A module-level tracker bridges the two without weaving a context object
 * through every hook call site (mirrors the `_lastWarningResponse` /
 * `MistakeDetector` pattern already in place).
 *
 * Honors B-4: never throws. Tracker corruption (e.g., somehow a record gets
 * miswired) cannot block the agent.
 */

import type { PhaseOutcomeKind, PrincipleRef } from "./phase-outcome.js";

export interface PhaseSnapshot {
  phaseName: string;
  startedAt: number;
  endedAt: number;
  toolCount: number;
  principleRefs: PrincipleRef[];
  /** Aggregate verifier verdict observed during the phase. */
  verifyResult: "pass" | "fail" | "skip" | null;
  hadFailure: boolean;
  aborted: boolean;
  abortReason?: string;
}

interface PhaseState {
  phaseName: string;
  startedAt: number;
  toolCount: number;
  principleRefs: PrincipleRef[];
  /** Track unique principle IDs to avoid double-counting on repeat surfaces. */
  seenPrincipleIds: Set<string>;
  verifyResult: "pass" | "fail" | "skip" | null;
  hadFailure: boolean;
  aborted: boolean;
  abortReason?: string;
}

let _state: PhaseState | null = null;

function newState(phaseName: string): PhaseState {
  return {
    phaseName,
    startedAt: Date.now(),
    toolCount: 0,
    principleRefs: [],
    seenPrincipleIds: new Set(),
    verifyResult: null,
    hadFailure: false,
    aborted: false,
  };
}

/**
 * Determine the phase outcome from collected signals.
 *
 * Conservative — only returns a verdict when we have an unambiguous signal:
 *   - aborted        → "abandoned"
 *   - verifyResult=fail → "fail"
 *   - verifyResult=pass → "pass"
 *   - everything else  → null (don't fire — insufficient signal)
 *
 * `hadFailure` alone does NOT fire a verdict: tool failures during execute
 * happen even on successful phases (build retries, recoverable errors).
 * Only the explicit verifier verdict is high-SNR enough.
 */
export function classifyOutcome(snap: PhaseSnapshot): PhaseOutcomeKind | null {
  if (snap.aborted) return "abandoned";
  if (snap.verifyResult === "fail") return "fail";
  if (snap.verifyResult === "pass") return "pass";
  return null;
}

/**
 * Record principle refs surfaced by an intercept call. Dedupes by
 * principle_uuid so a re-surface in a later tool of the same phase doesn't
 * inflate the credit-assignment list.
 */
export function recordIntercept(refs: PrincipleRef[]): void {
  if (!_state) return;
  if (!Array.isArray(refs) || refs.length === 0) return;
  _state.toolCount++;
  for (const ref of refs) {
    if (!ref?.pointId || !ref.collection) continue;
    if (_state.seenPrincipleIds.has(ref.pointId)) continue;
    _state.seenPrincipleIds.add(ref.pointId);
    _state.principleRefs.push(ref);
  }
}

/** Mark whether the latest posttool succeeded + carry verify outcome. */
export function recordPostTool(opts: { success: boolean; verifyResult?: "pass" | "fail" | "skip" }): void {
  if (!_state) return;
  if (!opts.success) _state.hadFailure = true;
  if (opts.verifyResult) {
    // Last verifyResult wins, but a "fail" sticks unless explicitly overridden
    // by a later "pass" (rare but possible if user re-runs verifier).
    _state.verifyResult = opts.verifyResult;
  }
}

/** Record abort event (called from the orchestrator's abort listener). */
export function markAborted(reason?: string): void {
  if (!_state) return;
  _state.aborted = true;
  if (reason) _state.abortReason = reason;
}

/**
 * Set the current phase. When the phase NAME changes from a non-null prior
 * phase, returns a snapshot of the prior phase for the orchestrator to ship.
 *
 * Calling with the same name is a no-op (continues accumulating).
 * Calling with `null` ends the current phase WITHOUT returning a snapshot —
 * use `endPhase()` for explicit termination.
 */
export function setPhase(phaseName: string | null): PhaseSnapshot | null {
  // Same phase as before → continue accumulating.
  if (_state?.phaseName === phaseName) return null;

  let drained: PhaseSnapshot | null = null;
  if (_state) {
    drained = {
      phaseName: _state.phaseName,
      startedAt: _state.startedAt,
      endedAt: Date.now(),
      toolCount: _state.toolCount,
      principleRefs: [..._state.principleRefs],
      verifyResult: _state.verifyResult,
      hadFailure: _state.hadFailure,
      aborted: _state.aborted,
      ...(_state.abortReason ? { abortReason: _state.abortReason } : {}),
    };
  }

  _state = phaseName ? newState(phaseName) : null;
  return drained;
}

/**
 * Explicitly end the current phase. Returns the snapshot if any. Used at
 * session end to flush the last open phase.
 */
export function endPhase(): PhaseSnapshot | null {
  if (!_state) return null;
  const drained: PhaseSnapshot = {
    phaseName: _state.phaseName,
    startedAt: _state.startedAt,
    endedAt: Date.now(),
    toolCount: _state.toolCount,
    principleRefs: [..._state.principleRefs],
    verifyResult: _state.verifyResult,
    hadFailure: _state.hadFailure,
    aborted: _state.aborted,
    ...(_state.abortReason ? { abortReason: _state.abortReason } : {}),
  };
  _state = null;
  return drained;
}

/** Test-only — reset all tracker state. */
export function resetPhaseTracker(): void {
  _state = null;
}

/** Test-only introspection — return the current state, or null if no phase active. */
export function _peekState(): Readonly<PhaseState> | null {
  return _state;
}
