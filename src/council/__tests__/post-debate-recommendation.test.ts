/**
 * Issue #3 — post-debate default mismatch.
 *
 * Before the fix, `runCouncil`'s post-debate AskCard recommended "generate_plan"
 * (Lock plan & execute Sprint 1) for ANY successful synthesis with no plan yet —
 * ignoring `debatePlan.outputShape.kind`. For a pure decision/evaluation topic the
 * user wanted a decision, not to build, so defaulting to "kick off a sprint" was
 * the wrong next step. `pickPostDebateRecommendation` now only defaults to
 * `implement` for `implementation_plan`-shaped debates; everything else defaults
 * to `save_exit` (the synthesis IS the deliverable). `generate_plan` itself was a
 * separate, always-identical alias to `implement` and was removed outright
 * (2026-08-04, see docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md)
 * — the Start Implementation OPTION is still offered; only the pre-selected
 * default and the action's name changed.
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
  it("defaults implementation_plan (no plan yet) to implement", () => {
    const r = pickPostDebateRecommendation({ ...base, outputKind: "implementation_plan" });
    expect(r.value).toBe("implement");
  });

  for (const kind of ["decision", "evaluation", "investigation", "resolve_question"] as const) {
    it(`defaults ${kind} (no plan) to save_exit, not implement`, () => {
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

  // DELIBERATELY CHANGED (session 115a59c9bb9e/49f6b8c1d8d6, this fix): this
  // test used to assert `refine` here for an `implementation_plan` debate too.
  // That was itself the recommendation half of the live defect — evidence
  // (plan-phase.ts `runPlannerPhase`) shows the plan draft is built from the
  // full synthesis TEXT + exchange transcript, never from `outcome.sections`,
  // so an empty structured section cannot block "Start Implementation" for an
  // implementation-shape debate. `refine` now wins on empty sections only for
  // an analysis-shape kind, where the sections ARE the deliverable — see the
  // next test.
  it("implementation_plan with empty sections still recommends implement, not refine", () => {
    const r = pickPostDebateRecommendation({
      ...base,
      hasEmptySections: true,
      refinementTopics: ["Risks", "Trade-offs"],
      outputKind: "implementation_plan",
    });
    expect(r.value).toBe("implement");
  });

  it("an analysis-shape kind with empty sections still recommends refine (sections ARE the deliverable there)", () => {
    const r = pickPostDebateRecommendation({
      ...base,
      hasEmptySections: true,
      refinementTopics: ["Risks", "Trade-offs"],
      outputKind: "evaluation",
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

/**
 * Session 115a59c9bb9e/49f6b8c1d8d6 — intent-aware recommendation.
 *
 * Live defect: the user's turn literally said "ok tiến hành implement theo
 * plan kết hợp sub agent" (PIL classified taskType="generate",
 * intentKind="task"), a 4-round debate ran, and the debate's own LOCKED
 * `outputKind` still read as an analysis-shape kind (stale relative to this
 * follow-up) — so `pickPostDebateRecommendation` recommended "refine" ("Fill
 * in 9 section(s)...") despite the turn asking to build. `turnWantsImplementation`
 * is the PIL-derived override that lets THIS turn's own intent win even when
 * the debate's locked kind disagrees.
 */
describe("pickPostDebateRecommendation — turnWantsImplementation (PIL override)", () => {
  const analysisBase = { ...base, outputKind: "evaluation" as const };

  it("reproduces the live defect shape: 9 empty sections + implement-intent turn → implement, not refine/save_exit", () => {
    const nineSections = [
      "agreed_architecture",
      "entities",
      "endpoints",
      "acceptance_criteria",
      "tradeoffs",
      "risks",
      "actionItems",
      "dissenting_notes",
      "mvp_definition",
    ];
    const r = pickPostDebateRecommendation({
      ...analysisBase,
      hasEmptySections: true,
      refinementTopics: nineSections,
      turnWantsImplementation: true,
    });
    expect(r.value).toBe("implement");
    expect(r.value).not.toBe("save_exit");
    expect(r.value).not.toBe("refine");
  });

  it("an analysis-kind debate with NO implement-intent override still recommends save_exit (baseline unchanged)", () => {
    const r = pickPostDebateRecommendation({ ...analysisBase });
    expect(r.value).toBe("save_exit");
  });

  it("turnWantsImplementation alone (no empty sections) still flips an analysis-kind, no-plan debate to implement", () => {
    const r = pickPostDebateRecommendation({ ...analysisBase, turnWantsImplementation: true });
    expect(r.value).toBe("implement");
  });

  it("turnWantsImplementation does not override low confidence — a thin debate still asks a follow-up first", () => {
    const r = pickPostDebateRecommendation({ ...analysisBase, confidenceLevel: "low", turnWantsImplementation: true });
    expect(r.value).toBe("ask_followup");
  });

  it("turnWantsImplementation does not override unmet criteria", () => {
    const r = pickPostDebateRecommendation({ ...analysisBase, criteriaUnmet: 1, turnWantsImplementation: true });
    expect(r.value).toBe("ask_followup");
  });

  it("turnWantsImplementation is a no-op once a plan already exists (still save_exit)", () => {
    const r = pickPostDebateRecommendation({ ...analysisBase, hasPlan: true, turnWantsImplementation: true });
    expect(r.value).toBe("save_exit");
  });

  it("implementation-shape kind already implies implementation-leaning without needing the override", () => {
    const r = pickPostDebateRecommendation({
      ...base,
      outputKind: "implementation_plan",
      hasEmptySections: true,
      refinementTopics: ["x"],
      turnWantsImplementation: false,
    });
    expect(r.value).toBe("implement");
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
    expect(out).toEqual({ total: 3, metCount: 2, unmetLabels: ["B"], deferredLabels: [], inconclusive: true });
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
      deferredLabels: [],
      inconclusive: true,
    });
    expect(summarizeCriteriaOutcome(crit, [true]).unmetLabels).toEqual(["B", "C"]);
  });

  it("is never inconclusive when there are no pinned criteria", () => {
    expect(summarizeCriteriaOutcome([], undefined).inconclusive).toBe(false);
    expect(summarizeCriteriaOutcome([], []).inconclusive).toBe(false);
  });

  // A criterion the leader marked `deferred` is only closable AFTER the debate
  // (code landed, tests run). Counting it as "unmet" is what made session
  // 811336618ee0 read as a failed 2/4 run and sold two extra debate rounds that
  // could not possibly move the number.
  it("splits deferred criteria out of unmet and does not call the outcome inconclusive", () => {
    const out = summarizeCriteriaOutcome(crit, [true, false, false], [false, true, true]);
    expect(out.metCount).toBe(1);
    expect(out.unmetLabels).toEqual([]);
    expect(out.deferredLabels).toEqual(["B", "C"]);
    expect(out.inconclusive).toBe(false);
  });

  it("stays inconclusive when a genuinely-open criterion sits beside a deferred one", () => {
    const out = summarizeCriteriaOutcome(crit, [true, false, false], [false, false, true]);
    expect(out.unmetLabels).toEqual(["B"]);
    expect(out.deferredLabels).toEqual(["C"]);
    expect(out.inconclusive).toBe(true);
  });

  it("never counts a MET criterion as deferred", () => {
    // met wins: a leader that marks a satisfied criterion deferred must not make
    // it vanish from metCount or reappear as outstanding work.
    const out = summarizeCriteriaOutcome(crit, [true, true, true], [true, true, true]);
    expect(out.metCount).toBe(3);
    expect(out.deferredLabels).toEqual([]);
    expect(out.unmetLabels).toEqual([]);
    expect(out.inconclusive).toBe(false);
  });
});
