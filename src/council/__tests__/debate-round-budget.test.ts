/**
 * C (latency UX) — per-kind debate round cap. Before this, only implementation_plan
 * was capped (3); a `decision` debate inherited the absolute ceiling (8) and ran as
 * many rounds as the planner proposed. Live, a Redis-vs-in-memory decision ran 5
 * rounds / ~10 min with the leader itself calling rounds 4-5 "minor disagreements".
 * resolveDebateRoundBudget now caps the discussion kinds at 3 (exploration 5).
 */
import { describe, expect, it } from "vitest";
import { resolveDebateRoundBudget } from "../debate.js";

describe("resolveDebateRoundBudget — per-kind round cap (issue C)", () => {
  it("caps a decision at 3 rounds even when the planner proposes 5", () => {
    const r = resolveDebateRoundBudget("decision", 5);
    expect(r.maxRounds).toBe(3);
    expect(r.effectiveCeiling).toBe(3);
    expect(r.kindCapped).toBe(true);
  });

  it("caps evaluation and investigation at 3", () => {
    expect(resolveDebateRoundBudget("evaluation", 8).maxRounds).toBe(3);
    expect(resolveDebateRoundBudget("investigation", 8).maxRounds).toBe(3);
  });

  it("keeps implementation_plan at its existing 3-round cap", () => {
    expect(resolveDebateRoundBudget("implementation_plan", 5).maxRounds).toBe(3);
  });

  it("allows exploration more breadth (5)", () => {
    const r = resolveDebateRoundBudget("exploration", 8);
    expect(r.maxRounds).toBe(5);
    expect(r.effectiveCeiling).toBe(5);
  });

  it("falls back to the absolute ceiling (8) for an unknown kind", () => {
    const r = resolveDebateRoundBudget("something-else", 7);
    expect(r.maxRounds).toBe(7);
    expect(r.effectiveCeiling).toBe(8);
    expect(r.kindCapped).toBe(false);
  });

  it("uses the default budget (3) when the planner proposes nothing", () => {
    expect(resolveDebateRoundBudget("decision", undefined).maxRounds).toBe(3);
    expect(resolveDebateRoundBudget(undefined, undefined).maxRounds).toBe(3);
    expect(resolveDebateRoundBudget(undefined, 0).maxRounds).toBe(3);
  });

  it("respects a planner proposal lower than the cap", () => {
    expect(resolveDebateRoundBudget("decision", 1).maxRounds).toBe(1);
    expect(resolveDebateRoundBudget("implementation_plan", 2).maxRounds).toBe(2);
  });
});
