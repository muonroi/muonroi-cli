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
import { describe, expect, it, vi } from "vitest";
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

describe("resolvePostDebateDefaultIndex — the DEFAULT must name the RECOMMENDED option (A2, session 115a59c9bb9e/49f6b8c1d8d6)", () => {
  // Live defect this closes: pickPostDebateRecommendation computed "refine"
  // ("Fill in 9 section(s)...") but the card's label read "Save & Exit" —
  // Amendment A1's resolver picked the first list-order-eligible option
  // (always ~index 0) with NO knowledge of what was actually recommended.
  // Amendment A2 looks the recommended VALUE up in `options` directly.

  it("resolves to the option whose value equals the recommended action, regardless of its position in the list", () => {
    // "refine" sits LAST here — a pure list-order/ranking resolver would never
    // find it without also being told what to look for.
    const options = [
      { value: "save_exit" },
      { value: "continue_session" },
      { value: "implement" },
      { value: "refine" },
    ];
    expect(resolvePostDebateDefaultIndex(options, "evaluation", "refine")).toBe(3);
    expect(resolvePostDebateDefaultIndex(options, "evaluation", "save_exit")).toBe(0);
    expect(resolvePostDebateDefaultIndex(options, "implementation_plan", "implement")).toBe(2);
  });

  it("for both implementation kinds, a recommended 'implement' resolves to wherever it sits", () => {
    for (const k of IMPLEMENTATION_INTENT_KINDS) {
      const options = [{ value: "implement" }, { value: "save_exit" }, { value: "continue_session" }];
      expect(resolvePostDebateDefaultIndex(options, k, "implement")).toBe(0);
    }
  });

  it("a recommended action missing from the options falls back explicitly (never a silent wrong index) and logs it", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // "implement" is not offered at all here — the fallback must still
      // return SOME in-bounds index (never throw, never -1) and must log the
      // mismatch rather than silently mis-defaulting.
      const options = [{ value: "save_exit" }, { value: "continue_session" }];
      const idx = resolvePostDebateDefaultIndex(options, "evaluation", "implement");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(options.length);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toContain("implement");
      expect(errSpy.mock.calls[0][0]).toContain("missing from the offered options");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("falls back to 0 when every option is ineligible AND the recommended action is absent — a list containing nothing but 'implement' entries under an analysis kind", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const k of ANALYSIS_INTENT_KINDS) {
        expect(resolvePostDebateDefaultIndex([{ value: "implement" }], k, "save_exit")).toBe(0);
        expect(resolvePostDebateDefaultIndex([{ value: "implement" }, { value: "implement" }], k, "save_exit")).toBe(0);
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  // ── Invariant, pinned as a property over every option-list shape index.ts
  // actually builds (not just one example) — the label, the reason and the
  // default MUST always describe the SAME option. Since the recommendReason
  // in index.ts is `baseOptions[defaultIndex]?.description`, this is exactly
  // "baseOptions[resolvePostDebateDefaultIndex(...)].value === recommendation.value"
  // whenever the recommended action is present — which it always is here, by
  // construction of each fixture below (mirrors index.ts's own guarantees:
  // save_exit/implement/continue_session/refine/retry_synthesis/ask_followup
  // are unconditionally added before the default is resolved).
  const OPTION_LIST_SHAPES: Array<{ name: string; options: Array<{ value: string }> }> = [
    {
      name: "deterministic fallback set (synthesis ok)",
      options: [{ value: "save_exit" }, { value: "refine" }, { value: "continue_session" }, { value: "implement" }],
    },
    {
      name: "deterministic fallback set (synthesis failed)",
      options: [{ value: "retry_synthesis" }, { value: "save_exit" }, { value: "continue_session" }],
    },
    {
      name: "model-first set with implement ranked first",
      options: [{ value: "implement" }, { value: "continue_session" }, { value: "refine" }, { value: "save_exit" }],
    },
    {
      name: "model-first set with save_exit ranked first",
      options: [{ value: "save_exit" }, { value: "implement" }, { value: "continue_session" }],
    },
  ];
  const RECOMMENDABLE_VALUES = ["save_exit", "implement", "refine", "retry_synthesis", "continue_session"];

  for (const shape of OPTION_LIST_SHAPES) {
    for (const recommended of RECOMMENDABLE_VALUES) {
      if (!shape.options.some((o) => o.value === recommended)) continue;
      it(`invariant holds — "${shape.name}" recommending "${recommended}"`, () => {
        for (const k of [...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS]) {
          const idx = resolvePostDebateDefaultIndex(shape.options, k, recommended);
          // The option the default POINTS AT is the one recommended — so a
          // caller reading label/description off `options[idx]` can never
          // disagree with what was recommended.
          expect(shape.options[idx].value).toBe(recommended);
        }
      });
    }
  }
});
