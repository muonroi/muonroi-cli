import { describe, expect, test } from "bun:test";
import { layer2Personality } from "../layer2-personality";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "refactor the auth module",
    enriched: "refactor the auth module",
    taskType: "refactor",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [{ name: "intent-detection", applied: true, delta: "taskType=refactor" }],
    ...overrides,
  };
}

describe("layer2Personality", () => {
  test("appends personality hint for concise outputStyle", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "concise" }));
    expect(result.enriched).toContain("[personality:");
    expect(result.enriched).toContain("concise");
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
  });

  test("appends personality hint for detailed outputStyle", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "detailed" }));
    expect(result.enriched).toContain("detailed");
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer!.applied).toBe(true);
  });

  test("applies balanced personality when outputStyle is balanced", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "balanced" }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer!.applied).toBe(true);
  });

  test("skips when outputStyle is null", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: null }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
  });

  test("respects tokenBudget — hint stays within budget", async () => {
    const result = await layer2Personality(makeCtx({ tokenBudget: 50 }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        expect(chars).toBeLessThanOrEqual(50 * 4);
      }
    }
  });
});
