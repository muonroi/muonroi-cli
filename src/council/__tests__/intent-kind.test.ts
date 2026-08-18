/**
 * IntentKind — drift-prevention contract.
 *
 * The three prior drift bugs (bab91d29, 5c18d1d5, 12d3022b) all branched on a
 * free-form string the leader/synthesizer LLM emitted and the code trusted.
 * IntentKind bounds the vocabulary and coerceIntentKind maps any unknown value
 * to "evaluation" (the analysis-shape safe default — never a build mandate).
 *
 * These tests pin that contract so a future loosening of the type fails here.
 */
import { describe, expect, it } from "vitest";
import { pickPostDebateRecommendation, postDebateContinuation, resolvePostDebateDefaultIndex } from "../index.js";
import {
  ANALYSIS_INTENT_KINDS,
  coerceIntentKind,
  IMPLEMENTATION_INTENT_KINDS,
  isDefaultEligiblePostDebateAction,
  isImplementationKind,
} from "../types.js";

describe("coerceIntentKind — boundary coercion (bab91d29/12d3022b)", () => {
  it("maps any unknown/non-string value to 'evaluation' (safe analysis default)", () => {
    expect(coerceIntentKind("lolwut")).toBe("evaluation");
    expect(coerceIntentKind("")).toBe("evaluation");
    expect(coerceIntentKind("   ")).toBe("evaluation");
    expect(coerceIntentKind(undefined)).toBe("evaluation");
    expect(coerceIntentKind(null)).toBe("evaluation");
    expect(coerceIntentKind(42)).toBe("evaluation");
    expect(coerceIntentKind({ kind: "decision" })).toBe("evaluation");
  });

  it("preserves all 6 valid IntentKind values (trimmed)", () => {
    for (const k of [
      "decision",
      "evaluation",
      "investigation",
      "resolve_question",
      "implementation_plan",
      "action_items",
    ]) {
      expect(coerceIntentKind(k)).toBe(k);
    }
    // surrounding whitespace is tolerated — LLM output is rarely clean
    expect(coerceIntentKind("  decision  ")).toBe("decision");
    expect(coerceIntentKind("\tevaluation\n")).toBe("evaluation");
  });

  it("rejects case-variants and near-misses (no fuzzy matching)", () => {
    // A drifted "Implementation_Plan" or "implementationplan" must NOT silently
    // become a build mandate — that was the 12d3022b failure mode.
    expect(coerceIntentKind("Implementation_Plan")).toBe("evaluation");
    expect(coerceIntentKind("implementationplan")).toBe("evaluation");
    expect(coerceIntentKind("IMPLEMENTATION_PLAN")).toBe("evaluation");
    expect(coerceIntentKind("plan")).toBe("evaluation");
  });
});

describe("isImplementationKind — the only build-mandate kinds", () => {
  it("returns true ONLY for implementation_plan and action_items", () => {
    expect(isImplementationKind("implementation_plan")).toBe(true);
    expect(isImplementationKind("action_items")).toBe(true);
  });

  it("returns false for every analysis kind", () => {
    for (const k of ANALYSIS_INTENT_KINDS) {
      expect(isImplementationKind(k)).toBe(false);
    }
  });

  it("the two clusters partition IntentKind with no overlap", () => {
    // If these sets ever overlap or leave a gap, the type contract is broken.
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      expect(ANALYSIS_INTENT_KINDS.has(k)).toBe(false);
    }
    const union = new Set([...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS]);
    expect(union.size).toBe(ANALYSIS_INTENT_KINDS.size + IMPLEMENTATION_INTENT_KINDS.size);
  });
});

describe("pickPostDebateRecommendation — analysis kind never suggests a build action (12d3022b)", () => {
  const base = {
    synthesisFailed: false,
    hasEmptySections: false,
    refinementTopics: [] as string[],
    confidenceLevel: "high" as const,
    hasPlan: false,
  };

  it("an analysis kind with no plan defaults to save_exit, not implement", () => {
    const r = pickPostDebateRecommendation({ ...base, outputKind: "evaluation" });
    expect(r.value).toBe("save_exit");
    expect(r.value).not.toBe("implement");
  });

  it("only implementation_plan/action_items can default to implement", () => {
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      const r = pickPostDebateRecommendation({ ...base, outputKind: k });
      expect(r.value).toBe("implement");
    }
    for (const k of ANALYSIS_INTENT_KINDS) {
      const r = pickPostDebateRecommendation({ ...base, outputKind: k });
      expect(r.value).not.toBe("implement");
    }
  });
});

describe("postDebateContinuation — continue_session + analysis → null (5c18d1d5)", () => {
  // Session 578b2eae7099: "Continue the original task using this conclusion" on
  // an evaluation made the model invent phantom Phase-1..7 todos and edit files.
  // An analysis kind MUST NOT carry forward into a build continuation.

  it("continue_session on an analysis kind returns null (no phantom implementation)", () => {
    for (const k of ANALYSIS_INTENT_KINDS) {
      expect(postDebateContinuation("continue_session", "synthesis text", k)).toBeNull();
    }
  });

  it("continue_session on an implementation kind carries the conclusion forward", () => {
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      const prompt = postDebateContinuation("continue_session", "synthesis text", k);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain("synthesis text");
    }
  });

  it("implement never carries prose forward, for any kind (C1)", () => {
    // Used to assert the opposite ("implement always carries forward regardless
    // of kind"). That branch was the C1 defect: runCouncil relayed "implement"
    // before its own plan block ran, so tool-engine turned this string into a
    // second, UNGATED implementation turn on the raw synthesis — on top of the
    // gated per-phase loop, and even after that loop halted on a failed verify.
    // The arm is deleted; runCouncil resolves an implement pick to
    // execute_plan / save_exit before relaying.
    expect(postDebateContinuation("implement", "x", "evaluation")).toBeNull();
    expect(postDebateContinuation("implement", "x", "decision")).toBeNull();
    expect(postDebateContinuation("implement", "x", "implementation_plan")).toBeNull();
  });

  it("generate_plan is no longer a valid action — dropped as a dead alias to implement", () => {
    expect(postDebateContinuation("generate_plan", "x", "evaluation")).toBeNull();
  });
});

describe("isDefaultEligiblePostDebateAction — Amendment A1 default-eligibility (947db934b573)", () => {
  // Off-intent actions stay VISIBLE (this predicate never filters the option
  // list — see resolvePostDebateDefaultIndex below); it only answers whether an
  // action is allowed to be the pre-selected DEFAULT.

  it("implement is default-ineligible for every analysis-shape kind", () => {
    for (const k of ANALYSIS_INTENT_KINDS) {
      expect(isDefaultEligiblePostDebateAction(k, "implement")).toBe(false);
    }
  });

  it("implement is default-eligible for both implementation-shape kinds", () => {
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      expect(isDefaultEligiblePostDebateAction(k, "implement")).toBe(true);
    }
  });

  it("every other action id is default-eligible regardless of locked kind", () => {
    // ask_followup / save_exit / continue_session are the real PostDebateActionId
    // vocabulary minus "implement"; refine / retry_synthesis are the context-only
    // values index.ts adds itself. "implement" is the ONLY build action, so it is
    // the only one this predicate ever gates — pinning that here catches a future
    // regression that widens the gate to actions it was never meant to cover.
    const allKinds = [...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS];
    const otherActions = ["ask_followup", "save_exit", "continue_session", "refine", "retry_synthesis"];
    for (const k of allKinds) {
      for (const action of otherActions) {
        expect(isDefaultEligiblePostDebateAction(k, action)).toBe(true);
      }
    }
  });

  it("ask_followup — the option the inconclusive/lowGrounding branches pin at index 0 — is default-eligible for every kind", () => {
    // index.ts hardcodes defaultIndex = 0 when inconclusive || lowGrounding
    // (bypassing resolvePostDebateDefaultIndex entirely) because both branches
    // unshift an ask_followup option ("Keep working the N unmet criteria" /
    // "Raise confidence — have the council cite & verify") as the honest
    // default. That short-circuit is only safe because ask_followup can never
    // be the one gated action — pin the premise here so it fails loudly if the
    // predicate is ever widened past "implement" without updating index.ts.
    for (const k of [...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS]) {
      expect(isDefaultEligiblePostDebateAction(k, "ask_followup")).toBe(true);
    }
  });
});

describe("resolvePostDebateDefaultIndex — the lock must constrain the DEFAULT, not the list (A1, session 947db934b573)", () => {
  // Live defect this closes: intent locked to "evaluation",
  // pickPostDebateRecommendation correctly returned save_exit, the leader
  // ranked "implement" first, and the card defaulted to implement anyway
  // because the old code set defaultIndex = 0 whenever modelActions existed,
  // discarding both the lock and `recommendation`.
  //
  // Signature note (code review round 1): resolvePostDebateDefaultIndex takes
  // only (options, intentKind) — no recommendationValue. An earlier version
  // also tried a recommendation-value lookup and an explicit escape-hatch
  // lookup as fallback tiers; review proved no input could ever reach either
  // one with a different answer than the eligible-option lookup already gives
  // (see the function's doc comment for why), so no test could fail without
  // them. Removed per YAGNI rather than kept as untestable dead code.

  it("a model ranking with implement at index 0 does NOT produce defaultIndex 0 for any analysis kind — and implement stays present, not filtered", () => {
    for (const k of ANALYSIS_INTENT_KINDS) {
      const options = [{ value: "implement" }, { value: "save_exit" }, { value: "continue_session" }];
      const idx = resolvePostDebateDefaultIndex(options, k);

      expect(idx).not.toBe(0);
      expect(options[idx].value).not.toBe("implement");
      // The ruling is "not default", not "not offered" — the option must still
      // be in the list the resolver was given (resolvePostDebateDefaultIndex
      // never mutates/filters `options`).
      expect(options.some((o) => o.value === "implement")).toBe(true);
    }
  });

  it("for both implementation kinds, implement at index 0 IS the default", () => {
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      const options = [{ value: "implement" }, { value: "save_exit" }, { value: "continue_session" }];
      expect(resolvePostDebateDefaultIndex(options, k)).toBe(0);
    }
  });

  it("falls back to 0 when every option is ineligible — the only way that happens is a list containing nothing but 'implement' entries", () => {
    // "implement" is the only action isDefaultEligiblePostDebateAction ever
    // rejects, so eligibleIndex === -1 requires every entry's value to be
    // "implement" (any other value would already have matched). This is the
    // one remaining edge the floor exists for, distinct from the two tests
    // above (which both have a non-"implement" entry present and eligible).
    for (const k of ANALYSIS_INTENT_KINDS) {
      expect(resolvePostDebateDefaultIndex([{ value: "implement" }], k)).toBe(0);
      expect(resolvePostDebateDefaultIndex([{ value: "implement" }, { value: "implement" }], k)).toBe(0);
    }
  });
});
