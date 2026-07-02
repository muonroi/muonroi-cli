import { fireAndForgetPhaseOutcome, type PhaseOutcomeKind } from "../ee/phase-outcome.js";
import { logInteraction } from "../storage/interaction-log.js";
import { readPlanVerifyVerdict, readState } from "./workflow-engine.js";

export interface GsdNativeTelemetry {
  phase: string | null;
  depth: string | null;
  workflowKind?: string;
  loopPoint?: string;
  planVerified?: boolean;
  verifyVerdict?: string | null;
  councilPerspectives?: number;
  leaderModelId?: string;
  councilContextChars?: number;
  councilHadPriorConcerns?: boolean;
  phaseNumber?: string;
  shipNotes?: string[];
}

export const PLANNING_CHECKPOINT_QUERY =
  "Context checkpoint summary OR PLAN-VERIFY verdict OR gsd-native STATE.md .planning/ Progress DONE";

/** Forensics-visible gsd-native interaction event (Phase 3 telemetry / Phase 5 closure). */
export function logGsdNativeEvent(sessionId: string, data: GsdNativeTelemetry): void {
  if (!sessionId) return;
  try {
    logInteraction(sessionId, "pil", {
      eventSubtype: "gsd-native",
      data: { ...data, ts: Date.now() },
    });
  } catch (err) {
    console.error(`[gsd-ee-closure] logGsdNativeEvent failed: ${(err as Error).message}`);
  }
}

export interface VerifyOutcomeOpts {
  sessionId?: string;
  cwd: string;
  depth: string;
  passed: boolean;
  evidence?: Record<string, unknown>;
}

/** Fire EE phase-outcome on gsd verify:post pass/fail (best-effort, B-4 compliant). */
export function fireGsdVerifyOutcome(opts: VerifyOutcomeOpts): void {
  const { sessionId, cwd, depth, passed, evidence } = opts;
  const state = readState(cwd);
  const verdict = readPlanVerifyVerdict(cwd);
  const outcome: PhaseOutcomeKind = passed ? "pass" : "fail";

  logGsdNativeEvent(sessionId ?? "gsd-native", {
    phase: state.phase,
    depth,
    loopPoint: "verify:post",
    planVerified: state.planVerified,
    verifyVerdict: verdict,
    workflowKind: typeof evidence?.workflowKind === "string" ? evidence.workflowKind : undefined,
  });

  if (!sessionId) return;

  fireAndForgetPhaseOutcome({
    sessionId,
    phaseName: `gsd:verify:${state.phase ?? "unknown"}`,
    outcome,
    evidence: {
      cwd,
      depth,
      planVerified: state.planVerified,
      planVerifyVerdict: verdict,
      nativeHost: "muonroi-cli",
      ...evidence,
    },
  });
}
