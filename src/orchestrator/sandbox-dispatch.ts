// ---------------------------------------------------------------------------
// Orchestrator sandbox dispatch — SSOT phase signal emission
// ---------------------------------------------------------------------------
// Emits the PhaseSignal for the current turn so the gate can resolve a stateless
// capability mask. This is the only source of truth for the active phase; the
// gate must NOT cache or derive phase from session state.
// ---------------------------------------------------------------------------

import type { PhaseSignal } from "@muonroi/agent-harness-core/sandbox/types.js";

const TURN_SOURCE: PhaseSignal["source"] = "orchestrator-ssot";

let activePhase: PhaseSignal | null = null;

/**
 * Emit the phase signal for the current turn. This signal is consumed by the gate
 * and any boundary instrumentation; it is recomputed stateless per turn.
 */
export function emitPhase(phase: PhaseSignal["value"], turnId: string): PhaseSignal {
  const signal: PhaseSignal = {
    value: phase,
    source: TURN_SOURCE,
    turnId,
  };
  activePhase = signal;
  return signal;
}

/** Return the active phase signal for the current turn, or null if none emitted. */
export function getActivePhase(): PhaseSignal | null {
  return activePhase;
}

/** Clear the active phase (used between turns or on shutdown). */
export function clearPhase(): void {
  activePhase = null;
}
