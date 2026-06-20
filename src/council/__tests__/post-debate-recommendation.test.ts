/**
 * Issue #3 — post-debate default mismatch.
 *
 * Before the fix, `runCouncil`'s post-debate AskCard recommended "generate_plan"
 * (Lock plan & execute Sprint 1) for ANY successful synthesis with no plan yet —
 * ignoring `debatePlan.outputShape.kind`. For a pure decision/evaluation topic the
 * user wanted a decision, not to build, so defaulting to "kick off a sprint" was
 * the wrong next step. `pickPostDebateRecommendation` now only defaults to
 * generate_plan for `implementation_plan`-shaped debates; everything else defaults
 * to `save_exit` (the synthesis IS the deliverable). The generate_plan OPTION is
 * still offered — only the pre-selected default changed.
 */
import { describe, expect, it } from "vitest";
import { pickPostDebateRecommendation } from "../index.js";

const base = {
  synthesisFailed: false,
  hasEmptySections: false,
  refinementTopics: [] as string[],
  confidenceLevel: "high" as const,
  hasPlan: false,
};

describe("pickPostDebateRecommendation — issue #3 default", () => {
  it("defaults implementation_plan (no plan yet) to generate_plan", () => {
    const r = pickPostDebateRecommendation({ ...base, outputKind: "implementation_plan" });
    expect(r.value).toBe("generate_plan");
  });

  for (const kind of ["decision", "evaluation", "investigation", "exploration", "other"]) {
    it(`defaults ${kind} (no plan) to save_exit, not generate_plan`, () => {
      const r = pickPostDebateRecommendation({ ...base, outputKind: kind });
      expect(r.value).toBe("save_exit");
      // Reason names the shape so the card explains WHY save is the default.
      expect(r.reason).toContain(kind);
    });
  }

  it("retry_synthesis wins on synthesis failure regardless of kind", () => {
    const r = pickPostDebateRecommendation({ ...base, synthesisFailed: true, outputKind: "decision" });
    expect(r.value).toBe("retry_synthesis");
  });

  it("refine wins when the debate left sections empty", () => {
    const r = pickPostDebateRecommendation({
      ...base,
      hasEmptySections: true,
      refinementTopics: ["Risks", "Trade-offs"],
      outputKind: "implementation_plan",
    });
    expect(r.value).toBe("refine");
    expect(r.reason).toContain("2");
  });

  it("low confidence routes to ask_followup before the kind split", () => {
    const r = pickPostDebateRecommendation({ ...base, confidenceLevel: "low", outputKind: "implementation_plan" });
    expect(r.value).toBe("ask_followup");
  });

  it("an existing plan always defaults to save_exit", () => {
    const r = pickPostDebateRecommendation({ ...base, hasPlan: true, outputKind: "implementation_plan" });
    expect(r.value).toBe("save_exit");
  });
});
