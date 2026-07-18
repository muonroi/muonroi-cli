// ---------------------------------------------------------------------------
// Capability mask resolver — pure function of PhaseSignal, no session state
// ---------------------------------------------------------------------------

import type { CapabilityMask, PhaseSignal } from "./types.js";

/**
 * Resolve the capability mask for a phase signal. Stateless and recomputed each
 * turn; the orchestrator must emit a fresh PhaseSignal on every transition.
 */
export function resolve(phase: PhaseSignal): CapabilityMask {
  switch (phase.value) {
    case "Read":
      return { phase, allowedOps: new Set(["read"]) };
    case "Write":
      return { phase, allowedOps: new Set(["read", "write"]) };
    case "Exec":
      return { phase, allowedOps: new Set(["read", "write", "spawn"]) };
    default:
      // Exhaustive check; default to Read-only fail-safe.
      return { phase, allowedOps: new Set(["read"]) };
  }
}

/** Alias for consumers that prefer the noun form. */
export const resolveMask = resolve;
