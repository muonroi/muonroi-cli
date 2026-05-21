import type { CouncilPhaseEvent, CouncilPhaseKind, StreamChunk } from "../types/index.js";

/**
 * Helper to build council_phase stream chunks. Keeps the council flow code
 * focused on what's happening, not on chunk shape.
 */
export function phaseChunk(event: CouncilPhaseEvent): StreamChunk {
  return { type: "council_phase", councilPhase: event };
}

export function phaseStart(opts: {
  phaseId: string;
  kind: CouncilPhaseKind;
  label: string;
  detail?: string;
  /**
   * Override for the start timestamp. Defaults to Date.now(). Tests pass an
   * explicit value to keep the chunk deterministic; production callers omit.
   */
  startedAt?: number;
}): StreamChunk {
  return phaseChunk({
    phaseId: opts.phaseId,
    kind: opts.kind,
    state: "active",
    label: opts.label,
    detail: opts.detail,
    startedAt: opts.startedAt ?? Date.now(),
  });
}

export function phaseDone(opts: {
  phaseId: string;
  kind: CouncilPhaseKind;
  label: string;
  startedAt: number;
  detail?: string;
}): StreamChunk {
  return phaseChunk({
    phaseId: opts.phaseId,
    kind: opts.kind,
    state: "done",
    label: opts.label,
    detail: opts.detail,
    elapsedMs: Date.now() - opts.startedAt,
  });
}

export function phaseError(opts: {
  phaseId: string;
  kind: CouncilPhaseKind;
  label: string;
  startedAt: number;
  errorMessage: string;
}): StreamChunk {
  return phaseChunk({
    phaseId: opts.phaseId,
    kind: opts.kind,
    state: "error",
    label: opts.label,
    elapsedMs: Date.now() - opts.startedAt,
    errorMessage: opts.errorMessage,
  });
}
