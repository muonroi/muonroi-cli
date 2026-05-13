/**
 * src/product-loop/feedback-routing.ts
 *
 * Maps a failed done-gate condition to a focus text and optionally an assigned role
 * for the next sprint. Per CONTEXT.md "Continue feedback routing" table:
 *
 * | Failed condition | Next sprint focus |
 * |---|---|
 * | #1 engineering_floor | "fix verify failures" + paste lastVerify.detail |
 * | #2 evidence_regex    | "evidence missing for criteria X, Y" — Tester role assigned |
 * | #3 weighted_score    | "score N%, gap = unmet criteria [X, Y, Z]" — PO prioritize |
 * | #4 customer_debate   | "Customer disagrees: <reason>" — Architect/Implementer iterate |
 * | #5 user_approval     | "user feedback: <text>" — full re-plan |
 */

import type { ToolResult } from "../types/index.js";
import type { Criterion, DoneVerdict, RoleSlot } from "./types.js";

export interface ContinueFeedback {
  focus: string;
  assignedRole?: RoleSlot;
}

/**
 * Build the carry-over focus and (optional) assigned role for the next sprint
 * based on which Definition-of-Done condition failed.
 *
 * Output is deterministic for a fixed input.
 */
export function buildContinueFeedback(
  verdict: DoneVerdict,
  lastVerify: ToolResult | null,
  _criteria: Criterion[],
): ContinueFeedback {
  if (verdict.pass) {
    return { focus: "All conditions met." };
  }

  switch (verdict.failedCondition) {
    case "engineering_floor": {
      const detail = lastVerify?.output || lastVerify?.error || "No verify output available.";
      return {
        focus: `fix verify failures\n\n${detail}`,
      };
    }

    case "evidence_regex": {
      const missing = verdict.reason || "unknown criteria";
      return {
        focus: `evidence missing for criteria ${missing}`,
        assignedRole: "Tester",
      };
    }

    case "weighted_score": {
      const scorePct = Math.round(verdict.score * 100);
      const gap = verdict.reason || "unknown";
      return {
        focus: `score ${scorePct}%, gap = unmet criteria [${gap}]`,
        assignedRole: "PO",
      };
    }

    case "customer_debate": {
      return {
        focus: `Customer disagrees: ${verdict.reason || "no reason provided"}`,
        assignedRole: "Architect",
      };
    }

    case "user_approval": {
      return {
        focus: `user feedback: ${verdict.reason || "no feedback provided"}`,
      };
    }

    default:
      return {
        focus: `failed ${verdict.failedCondition || "unknown condition"}: ${verdict.reason || ""}`,
      };
  }
}
