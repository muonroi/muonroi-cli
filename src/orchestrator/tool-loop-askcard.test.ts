import { describe, expect, it } from "vitest";
import { planLoopCapAskcard } from "./tool-loop-askcard.js";

describe("planLoopCapAskcard", () => {
  it("early tier (< 0.5× ceiling): default Continue, no warning", () => {
    const r = planLoopCapAskcard({ stepNumber: 5, naturalCeiling: 12 });
    expect(r.tier).toBe("early");
    expect(r.defaultIndex).toBe(0);
    expect(r.optionLabels[0]).toMatch(/Continue/);
    expect(r.optionValues[0]).toBe("continue");
    expect(r.overageMultiplier).toBeNull();
    // no warning emoji on the Continue label
    expect(r.optionLabels[0]).not.toMatch(/⚠/);
  });

  it("normal tier (0.5×–2× ceiling): default Stop, no warning, Continue first", () => {
    const r = planLoopCapAskcard({ stepNumber: 18, naturalCeiling: 12 });
    expect(r.tier).toBe("normal");
    expect(r.defaultIndex).toBe(1);
    expect(r.optionLabels[0]).toBe("Continue (let agent try)");
    expect(r.optionLabels[1]).toBe("Stop and answer");
    expect(r.overageMultiplier).toBeNull();
  });

  it("overBudget tier (2×–5× ceiling): Continue carries the overage multiplier, default Stop", () => {
    // The storyflow_ui case: step 29 / ceiling 12 = 2.4×
    const r = planLoopCapAskcard({ stepNumber: 29, naturalCeiling: 12 });
    expect(r.tier).toBe("overBudget");
    expect(r.defaultIndex).toBe(1);
    expect(r.optionLabels[0]).toMatch(/⚠ 2\.4× past natural budget/);
    expect(r.optionLabels[1]).toMatch(/Stop and answer \(recommended\)/);
    expect(r.overageMultiplier).toBe("2.4");
    // order preserved: Continue at 0, Stop at 1
    expect(r.optionValues).toEqual(["continue", "stop"]);
  });

  it("extreme tier (> 5× ceiling): Stop FIRST in the array, Continue labelled expensive", () => {
    // session 1f29e238 — step 77 / ceiling 6 = 12.8×
    const r = planLoopCapAskcard({ stepNumber: 77, naturalCeiling: 6 });
    expect(r.tier).toBe("extreme");
    expect(r.defaultIndex).toBe(0);
    expect(r.optionLabels[0]).toMatch(/Stop and answer \(recommended\)/);
    expect(r.optionLabels[1]).toMatch(/⚠ 12\.8× over budget — expensive/);
    expect(r.optionValues).toEqual(["stop", "continue"]); // ORDER REVERSED at extreme
    expect(r.overageMultiplier).toBe("12.8");
  });

  it("tier boundaries are open-on-the-lower-side (ratio==2 → normal; ratio==5 → overBudget; ratio==0.5 → normal)", () => {
    // ratio === 2.0 exactly → still normal (the > 2 gate excludes 2.0)
    expect(planLoopCapAskcard({ stepNumber: 24, naturalCeiling: 12 }).tier).toBe("normal");
    // ratio === 5.0 exactly → still overBudget (the > 5 gate excludes 5.0)
    expect(planLoopCapAskcard({ stepNumber: 60, naturalCeiling: 12 }).tier).toBe("overBudget");
    // ratio === 0.5 exactly → normal (the < 0.5 gate excludes 0.5)
    expect(planLoopCapAskcard({ stepNumber: 6, naturalCeiling: 12 }).tier).toBe("normal");
  });

  it("falls back to step-threshold heuristic when naturalCeiling is missing", () => {
    const early = planLoopCapAskcard({ stepNumber: 8 });
    expect(early.tier).toBe("early");
    expect(early.defaultIndex).toBe(0);

    const normal = planLoopCapAskcard({ stepNumber: 22 });
    expect(normal.tier).toBe("normal");
    expect(normal.defaultIndex).toBe(1);

    // boundary: step === 15 → still early
    expect(planLoopCapAskcard({ stepNumber: 15 }).tier).toBe("early");
    // step === 16 → normal
    expect(planLoopCapAskcard({ stepNumber: 16 }).tier).toBe("normal");
    // step === 0 → normal (no early credit for nothing)
    expect(planLoopCapAskcard({ stepNumber: 0 }).tier).toBe("normal");
  });

  it("treats naturalCeiling=0 the same as undefined (no multiplier possible)", () => {
    const r = planLoopCapAskcard({ stepNumber: 30, naturalCeiling: 0 });
    expect(r.overageMultiplier).toBeNull();
    expect(r.tier).toBe("normal");
  });
});
