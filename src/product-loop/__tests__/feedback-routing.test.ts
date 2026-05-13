import { describe, expect, it } from "vitest";
import type { ToolResult } from "../../types/index.js";
import { buildContinueFeedback } from "../feedback-routing.js";
import type { Criterion, DoneVerdict } from "../types.js";

describe("feedback-routing", () => {
  const criteria: Criterion[] = [
    { id: "C1", status: "met" },
    { id: "C2", status: "unmet" },
    { id: "C3", status: "partial" },
  ];

  it("returns 'All conditions met.' when verdict.pass is true", () => {
    const verdict: DoneVerdict = { pass: true, score: 1.0 };
    expect(buildContinueFeedback(verdict, null, criteria).focus).toBe("All conditions met.");
  });

  it("Cond #1 (engineering_floor): pastes verify detail", () => {
    const verdict: DoneVerdict = { pass: false, failedCondition: "engineering_floor", score: 0.5 };
    const lastVerify: ToolResult = { success: false, output: "Tests failed: expected 2 to be 3" };
    const result = buildContinueFeedback(verdict, lastVerify, criteria);
    expect(result.focus).toContain("fix verify failures");
    expect(result.focus).toContain("Tests failed: expected 2 to be 3");
    expect(result.assignedRole).toBeUndefined();
  });

  it("Cond #1 falls back to error field then placeholder", () => {
    const verdict: DoneVerdict = { pass: false, failedCondition: "engineering_floor", score: 0.5 };
    const errVerify: ToolResult = { success: false, output: "", error: "ENOENT recipe" };
    expect(buildContinueFeedback(verdict, errVerify, criteria).focus).toContain("ENOENT recipe");
    expect(buildContinueFeedback(verdict, null, criteria).focus).toContain("No verify output available.");
  });

  it("Cond #2 (evidence_regex): assigns Tester", () => {
    const verdict: DoneVerdict = {
      pass: false,
      failedCondition: "evidence_regex",
      score: 0.8,
      reason: "C2, C3",
    };
    const result = buildContinueFeedback(verdict, null, criteria);
    expect(result.focus).toBe("evidence missing for criteria C2, C3");
    expect(result.assignedRole).toBe("Tester");
  });

  it("Cond #3 (weighted_score): assigns PO and renders score%", () => {
    const verdict: DoneVerdict = {
      pass: false,
      failedCondition: "weighted_score",
      score: 0.6,
      reason: "C2, C3",
    };
    const result = buildContinueFeedback(verdict, null, criteria);
    expect(result.focus).toBe("score 60%, gap = unmet criteria [C2, C3]");
    expect(result.assignedRole).toBe("PO");
  });

  it("Cond #4 (customer_debate): assigns Architect", () => {
    const verdict: DoneVerdict = {
      pass: false,
      failedCondition: "customer_debate",
      score: 0.9,
      reason: "Too complex for MVP",
    };
    const result = buildContinueFeedback(verdict, null, criteria);
    expect(result.focus).toBe("Customer disagrees: Too complex for MVP");
    expect(result.assignedRole).toBe("Architect");
  });

  it("Cond #5 (user_approval): no role assignment, free-form feedback", () => {
    const verdict: DoneVerdict = {
      pass: false,
      failedCondition: "user_approval",
      score: 0.95,
      reason: "Add login page",
    };
    const result = buildContinueFeedback(verdict, null, criteria);
    expect(result.focus).toBe("user feedback: Add login page");
    expect(result.assignedRole).toBeUndefined();
  });

  it("output is deterministic for fixed input", () => {
    const verdict: DoneVerdict = {
      pass: false,
      failedCondition: "weighted_score",
      score: 0.75,
      reason: "C2",
    };
    const a = buildContinueFeedback(verdict, null, criteria);
    const b = buildContinueFeedback(verdict, null, criteria);
    expect(a).toEqual(b);
  });
});
