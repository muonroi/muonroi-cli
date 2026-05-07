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
}): StreamChunk {
  return phaseChunk({
    phaseId: opts.phaseId,
    kind: opts.kind,
    state: "active",
    label: opts.label,
    detail: opts.detail,
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
