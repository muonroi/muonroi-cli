import { describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";

// CB-1 (halt when projected spend exceeds the cap's headroom) was deleted along
// with `/ideal`'s spend cap (user decision: no limits); its tests went with it.

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
