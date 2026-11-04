import { fireAndForgetPhaseOutcome, type PhaseOutcomeKind } from "../ee/phase-outcome.js";
import { logInteraction } from "../storage/interaction-log.js";
import { readPlanVerifyVerdict, readState } from "./workflow-engine.js";

export interface FlowNativeTelemetry {
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
  councilVerdictSource?: "structured" | "heuristic-fallback" | "parse-failed";
  councilVerdictParseFailed?: boolean;
  durationMs?: number;
  councilVerdict?: string;
  councilConcernCount?: number;
  reviewId?: string;
  reviewOutcome?: "complete" | "error";
  reviewError?: string;
  requestedModelId?: string;
  planReviewPath?: string;
  planVerifyPath?: string;
  phaseNumber?: string;
  shipNotes?: string[];
}

export const PLANNING_CHECKPOINT_QUERY =
  "Context checkpoint summary OR PLAN-VERIFY verdict OR flow-native STATE.md .planning/ Progress DONE";

/** Forensics-visible flow-native interaction event (Phase 3 telemetry / Phase 5 closure). */
export function logFlowNativeEvent(sessionId: string, data: FlowNativeTelemetry): void {
  if (!sessionId) return;
  try {
    logInteraction(sessionId, "pil", {
      eventSubtype: "flow-native",
      model: data.leaderModelId,
      durationMs: data.durationMs,
      data: { ...data, ts: Date.now() },
    });
  } catch (err) {
    console.error(`[flow-ee-closure] logFlowNativeEvent failed: ${(err as Error).message}`);
  }
}

export interface VerifyOutcomeOpts {
  sessionId?: string;
  cwd: string;
  depth: string;
  passed: boolean;
  evidence?: Record<string, unknown>;
}

/** Fire EE phase-outcome on flow verify:post pass/fail (best-effort, B-4 compliant). */
export function fireFlowVerifyOutcome(opts: VerifyOutcomeOpts): void {
  const { sessionId, cwd, depth, passed, evidence } = opts;
  const state = readState(cwd);
  const verdict = readPlanVerifyVerdict(cwd);
  const outcome: PhaseOutcomeKind = passed ? "pass" : "fail";

  logFlowNativeEvent(sessionId ?? "flow-native", {
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
    phaseName: `flow:verify:${state.phase ?? "unknown"}`,
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
