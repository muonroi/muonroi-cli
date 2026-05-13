/**
 * src/product-loop/phase-tracker-bridge.ts
 *
 * Bridge between the product loop and the EE phase tracker.
 * Translates sprint boundaries and outcomes into EE events.
 */

import { type FirePhaseOutcomeOpts, fireAndForgetPhaseOutcome, type PhaseOutcomeKind } from "../ee/phase-outcome.js";
import type { PhaseSnapshot } from "../ee/phase-tracker.js";

export interface PhaseTrackerLike {
  setPhase(name: string | null): PhaseSnapshot | null;
}

export interface PostSprintBoundaryArgs {
  sessionId: string;
  sprintN: number;
  outcome: PhaseOutcomeKind;
  evidence?: Record<string, unknown>;
  /** Optional override for the phase tracker (default uses singleton) */
  phaseTracker?: PhaseTrackerLike;
  /** Options for the firePhaseOutcome call */
  opts?: FirePhaseOutcomeOpts;
}

/**
 * Fire-and-forget bridge that maps product sprint boundaries to EE events.
 *
 * Called by the product loop driver at each sprint transition or terminal event.
 */
export async function postSprintBoundary(args: PostSprintBoundaryArgs): Promise<void> {
  const { sessionId, sprintN, outcome, evidence, phaseTracker, opts = {} } = args;

  // RESEARCH §2 confirmed boundary trigger is setPhase.
  // When we set a NEW phase, setPhase returns the snapshot of the PRIOR phase.
  const pt = phaseTracker ?? (await import("../ee/phase-tracker.js"));
  const snapshot = pt.setPhase(`sprint-${sprintN}`);

  if (snapshot) {
    fireAndForgetPhaseOutcome(
      {
        sessionId,
        phaseName: snapshot.phaseName,
        outcome,
        evidence: {
          ...snapshot,
          ...evidence,
          // Ensure evidence carries the aggregate verifier results if they existed
          verifierResult:
            snapshot.verifyResult === "pass"
              ? { passed: 1, failed: 0 }
              : snapshot.verifyResult === "fail"
                ? { passed: 0, failed: 1 }
                : undefined,
        },
      },
      opts,
    );
  }
}
