import { describe, expect, it } from "vitest";
import { layer4Gsd } from "../layer4-gsd";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "implement the login feature",
    enriched: "implement the login feature",
    taskType: "generate",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer4Gsd", () => {
  it("detects execute phase from raw prompt and appends hint", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "implement the login feature" }));
    expect(result.enriched).toContain("[gsd:");
    expect(result.enriched).toContain("execute");
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("phase=execute");
  });

  it("uses gsdPhase from context if already set", async () => {
    const result = await layer4Gsd(makeCtx({ gsdPhase: "plan", raw: "do something" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("phase=plan");
  });

  it("detects plan phase from keywords", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "plan the architecture" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("phase=plan");
  });

  it("detects verify phase from keywords", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "test this function" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("phase=verify");
  });

  it("skips when no phase detected and no gsdPhase in context", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "hello there", gsdPhase: null }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
  });

  it("respects tokenBudget", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "implement this", tokenBudget: 30 }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    if (layer?.applied && layer.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        expect(parseInt(charsMatch[1], 10)).toBeLessThanOrEqual(30 * 4);
      }
    }
  });

  it("updates gsdPhase on context when detected", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "review the pull request" }));
    expect(result.gsdPhase).toBe("review");
  });
});
