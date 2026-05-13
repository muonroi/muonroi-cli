import { describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { CB1_costProjection, CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";

describe("CB-1 cost projection — coverage gaps", () => {
  it("returns zero projection when history empty and no baseline", () => {
    const r = CB1_costProjection([], 50, 0);
    expect(r.projection).toBe(0);
    expect(r.halt).toBe(false);
    expect(r.headroom).toBe(50);
  });

  it("ignores baselineCost when history is non-empty", () => {
    // history=[10], baseline=999 → ewma should use 10, not baseline
    const r = CB1_costProjection([{ actualCost: 10 }], 100, 0, 999);
    expect(r.projection).toBeCloseTo(12); // 10 * 1.2
  });

  it("slices to last 3 entries when history is longer", () => {
    // longer history; only last 3 (8, 9, 10) feed EWMA
    const r = CB1_costProjection(
      [{ actualCost: 1 }, { actualCost: 2 }, { actualCost: 8 }, { actualCost: 9 }, { actualCost: 10 }],
      100,
      0,
    );
    // recent=[8,9,10], ewma seeded with 8 → reduce: (8*0.7+9*0.3)=8.3 → (8.3*0.7+10*0.3)=8.81
    // projection = 8.81 * 1.2 = 10.572
    expect(r.projection).toBeCloseTo(10.572, 2);
  });

  it("does NOT halt at the boundary projection == remaining*1.5 (strict >)", () => {
    // engineer history so projection == remaining*1.5 exactly. Use baseline so empty-history math is simple.
    // baseline=10 → projection=12. cap-spent=8 → remaining*1.5=12. 12 > 12 is false → halt=false.
    const r = CB1_costProjection([], 8, 0, 10);
    expect(r.projection).toBe(12);
    expect(r.halt).toBe(false);
  });

  it("returns headroom = cap - spent regardless of halt", () => {
    const r = CB1_costProjection([{ actualCost: 100 }], 50, 30);
    expect(r.headroom).toBe(20);
    expect(r.halt).toBe(true);
  });
});

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
