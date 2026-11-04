import { existsSync } from "node:fs";
import { sessionUsedFlowWorkflow } from "../storage/index.js";
import { logger } from "../utils/logger.js";
import { isFlowNativeEnabled } from "../workflow/flags.js";
import { planningArtifact } from "../workflow/paths.js";
import { readCompletionScope, type WorkflowCompletionScope } from "../workflow/workflow-engine.js";
import type { ExecutionRole } from "./orchestration-policy.js";

/** Never borrow another conversation's workspace plan as this session's goal. */
export function ownedCompletionScope(
  cwd: string,
  sessionId: string | undefined,
  role: ExecutionRole | undefined,
  currentTurnFlowUsed = false,
): WorkflowCompletionScope | null {
  if (role !== "orchestrator" || !sessionId || !isFlowNativeEnabled() || !existsSync(planningArtifact(cwd, "PLAN.md")))
    return null;
  if (!currentTurnFlowUsed && !sessionUsedFlowWorkflow(sessionId)) return null;
  try {
    return readCompletionScope(cwd);
  } catch (err) {
    logger.file("warn", "orchestrator", "Native completion scope unavailable", {
      cwd,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      declaredPlanScope: null,
      planReview: null,
      implementationVerification: "unstructured",
      wholeTaskCompletion: "unverified",
      evidenceBoundary: "Host could not inspect completion evidence; do not claim verified completion.",
    };
  }
}

export function completionScopeGuidance(scope: WorkflowCompletionScope): string {
  return (
    `[Native completion scope; artifact facts, not authorization or whole-goal proof]\n${JSON.stringify(scope)}\n` +
    "Retain the original user goal separately from the current worker/preflight. Report completed scope, verified evidence, remaining deliverables and next action. Main must inspect raw evidence; doing so does not break independent verification. Do not promote plan approval, a helper's done message or a commit into whole-task completion."
  );
}
