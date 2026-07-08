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
import { pickPostDebateRecommendation, summarizeCriteriaOutcome } from "../index.js";

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

describe("pickPostDebateRecommendation — F1 unmet criteria", () => {
  it("unmet criteria dominate the output-kind default (no commit when not done)", () => {
    // High confidence + a plan would normally default to save_exit; unmet
    // criteria override that with a press-the-council recommendation.
    const r = pickPostDebateRecommendation({
      ...base,
      hasPlan: true,
      outputKind: "implementation_plan",
      criteriaUnmet: 2,
    });
    expect(r.value).toBe("ask_followup");
    expect(r.reason).toContain("2 success criteria still unmet");
  });

  it("uses singular phrasing for a single unmet criterion", () => {
    const r = pickPostDebateRecommendation({ ...base, outputKind: "decision", criteriaUnmet: 1 });
    expect(r.value).toBe("ask_followup");
    expect(r.reason).toContain("1 success criterion still unmet");
  });

  it("synthesis failure still wins over unmet criteria", () => {
    const r = pickPostDebateRecommendation({
      ...base,
      synthesisFailed: true,
      outputKind: "decision",
      criteriaUnmet: 3,
    });
    expect(r.value).toBe("retry_synthesis");
  });

  it("criteriaUnmet 0 / undefined leaves the existing behavior unchanged", () => {
    expect(pickPostDebateRecommendation({ ...base, outputKind: "decision", criteriaUnmet: 0 }).value).toBe("save_exit");
    expect(pickPostDebateRecommendation({ ...base, outputKind: "decision" }).value).toBe("save_exit");
  });
});

describe("summarizeCriteriaOutcome (F1)", () => {
  const crit = ["A", "B", "C"];

  it("counts met/unmet index-aligned and flags inconclusive when any is open", () => {
    const out = summarizeCriteriaOutcome(crit, [true, false, true]);
    expect(out).toEqual({ total: 3, metCount: 2, unmetLabels: ["B"], inconclusive: true });
  });

  it("is conclusive only when every criterion is met", () => {
    const out = summarizeCriteriaOutcome(crit, [true, true, true]);
    expect(out.inconclusive).toBe(false);
    expect(out.metCount).toBe(3);
  });

  it("treats a missing/short flags array as all-unmet", () => {
    expect(summarizeCriteriaOutcome(crit, undefined)).toEqual({
      total: 3,
      metCount: 0,
      unmetLabels: ["A", "B", "C"],
      inconclusive: true,
    });
    expect(summarizeCriteriaOutcome(crit, [true]).unmetLabels).toEqual(["B", "C"]);
  });

  it("is never inconclusive when there are no pinned criteria", () => {
    expect(summarizeCriteriaOutcome([], undefined).inconclusive).toBe(false);
    expect(summarizeCriteriaOutcome([], []).inconclusive).toBe(false);
  });
});
