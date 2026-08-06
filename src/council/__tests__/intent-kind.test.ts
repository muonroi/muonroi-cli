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
import { pickPostDebateRecommendation, postDebateContinuation } from "../index.js";
import {
  ANALYSIS_INTENT_KINDS,
  coerceIntentKind,
  IMPLEMENTATION_INTENT_KINDS,
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
