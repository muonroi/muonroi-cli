import { describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";

// CB-1 (cost projection against the cap's headroom) was deleted along with
// `/ideal`'s spend cap (user decision: no limits); its coverage tests went with it.

describe("CB-2 oscillation — coverage gaps", () => {
  it("returns no halt when sprintN >= 3 but history shorter than 3", () => {
    const r = CB2_oscillation([{ score: 0.5 }, { score: 0.5 }], 3);
    expect(r.halt).toBe(false);
    expect(r.delta_t).toBe(0);
    expect(r.delta_t_minus_1).toBe(0);
  });

  it("halts when both deltas are exactly zero", () => {
    const r = CB2_oscillation([{ score: 0.5 }, { score: 0.5 }, { score: 0.5 }], 3);
    expect(r.halt).toBe(true);
    expect(r.delta_t).toBe(0);
    expect(r.delta_t_minus_1).toBe(0);
  });

  it("does not halt when delta_t is positive even if delta_t-1 was non-positive", () => {
    // recovery scenario: stagnated then improved
    const r = CB2_oscillation([{ score: 0.5 }, { score: 0.5 }, { score: 0.7 }], 3);
    expect(r.halt).toBe(false);
    expect(r.delta_t).toBeCloseTo(0.2);
  });
});

describe("CB-3 verify blank — coverage gaps", () => {
  it("returns no halt for sprintN=0 even with null recipe", () => {
    expect(CB3_verifyBlank(0, null).halt).toBe(false);
  });

  it("does not halt when coverage is positive even if very small", () => {
    expect(CB3_verifyBlank(1, { coverage: 0.001 } as VerifyRecipe).halt).toBe(false);
  });

  it("ignores recipe shape when sprintN > 1", () => {
    expect(CB3_verifyBlank(5, null).halt).toBe(false);
    expect(CB3_verifyBlank(5, { coverage: 0 } as VerifyRecipe).halt).toBe(false);
  });
});
