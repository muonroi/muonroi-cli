// src/product-loop/__tests__/discovery-council-runner.test.ts
import { describe, expect, it } from "vitest";
import { buildBig4DebatePlan } from "../discovery-council-runner.js";

describe("discovery-council-runner — DebatePlan", () => {
  it("plan has intentSummary, 3 stances (named pragmatist/scaler/cost-optimizer), plannedRounds=1, outputShape", () => {
    const plan = buildBig4DebatePlan({ questionId: "backendArchitecture", contextSummary: "saas, 1k-100k, SEA" });
    expect(plan.plannedRounds).toBe(1);
    expect(plan.stances.map((s: any) => s.name)).toEqual(["pragmatist", "scaler", "cost-optimizer"]);
    expect(plan.intentSummary).toContain("backendArchitecture");
    expect(plan.outputShape).toBeDefined();
  });
});
