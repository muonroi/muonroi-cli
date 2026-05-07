import { describe, it, expect } from "vitest";
import { CB1_costProjection, CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import type { VerifyRecipe } from "../../types/index.js";

describe("CB-1 Cost Projection", () => {
  it("should calculate projection from baseline when history is empty", () => {
    const result = CB1_costProjection([], 50, 0, 5);
    expect(result.projection).toBe(6); // 5 * 1.2
    expect(result.halt).toBe(false); // 6 < 50 * 1.5
  });

  it("should calculate projection from history using EWMA", () => {
    // history: 10, 20, 30
    // ewma = (10 * 0.7 + 20 * 0.3) = 13 (sprint 2)
    // ewma = (13 * 0.7 + 30 * 0.3) = 9.1 + 9 = 18.1 (sprint 3)
    // wait, the formula is: ewma = recent.reduce((avg, c) => avg * 0.7 + c * 0.3, recent[0])
    // recent = [10, 20, 30]
    // initial avg = 10
    // iteration 1 (c=20): 10 * 0.7 + 20 * 0.3 = 7 + 6 = 13
    // iteration 2 (c=30): 13 * 0.7 + 30 * 0.3 = 9.1 + 9 = 18.1
    // projection = 18.1 * 1.2 = 21.72
    const history = [{ actualCost: 10 }, { actualCost: 20 }, { actualCost: 30 }];
    const result = CB1_costProjection(history, 100, 60);
    expect(result.projection).toBeCloseTo(21.72);
    expect(result.halt).toBe(false); // 21.72 < (100-60) * 1.5 = 60
  });

  it("should halt when projection exceeds 1.5x remaining budget", () => {
    const history = [{ actualCost: 10 }];
    // ewma = 10
    // projection = 12
    // remaining = 5
    // 12 > 5 * 1.5 (7.5) -> true
    const result = CB1_costProjection(history, 15, 10);
    expect(result.halt).toBe(true);
  });
});

describe("CB-2 Oscillation", () => {
  it("should not halt before sprint 3", () => {
    const history = [{ score: 0.1 }, { score: 0.1 }];
    expect(CB2_oscillation(history, 2).halt).toBe(false);
  });

  it("should halt when deltas are non-positive for 2 consecutive sprints", () => {
    // sprint 1: 0.5
    // sprint 2: 0.5 (delta=0)
    // sprint 3: 0.4 (delta=-0.1)
    const history = [{ score: 0.5 }, { score: 0.5 }, { score: 0.4 }];
    const result = CB2_oscillation(history, 3);
    expect(result.halt).toBe(true);
    expect(result.delta_t).toBeCloseTo(-0.1);
    expect(result.delta_t_minus_1).toBe(0);
  });

  it("should not halt if one delta is positive", () => {
    const history = [{ score: 0.5 }, { score: 0.4 }, { score: 0.6 }];
    expect(CB2_oscillation(history, 3).halt).toBe(false);
  });
});

describe("CB-3 Verify Blank", () => {
  it("should not halt after sprint 1", () => {
    expect(CB3_verifyBlank(2, null).halt).toBe(false);
  });

  it("should halt on sprint 1 if recipe is null", () => {
    const result = CB3_verifyBlank(1, null);
    expect(result.halt).toBe(true);
    expect(result.reason).toBe("no_recipe");
  });

  it("should halt on sprint 1 if coverage is 0", () => {
    const recipe = { coverage: 0 } as VerifyRecipe;
    const result = CB3_verifyBlank(1, recipe);
    expect(result.halt).toBe(true);
    expect(result.reason).toBe("zero_coverage");
  });

  it("should not halt if coverage is positive", () => {
    const recipe = { coverage: 0.1 } as VerifyRecipe;
    expect(CB3_verifyBlank(1, recipe).halt).toBe(false);
  });

  it("should not halt if coverage is undefined/null", () => {
    // CB-3 only halts if coverage is EXACTLY 0
    expect(CB3_verifyBlank(1, { coverage: null } as unknown as VerifyRecipe).halt).toBe(false);
    expect(CB3_verifyBlank(1, {} as VerifyRecipe).halt).toBe(false);
  });
});
