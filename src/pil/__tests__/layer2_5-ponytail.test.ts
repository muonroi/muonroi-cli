import { afterEach, describe, expect, it } from "vitest";
import { layer2_5Ponytail } from "../layer2_5-ponytail.js";
import type { PipelineContext } from "../types.js";

describe("layer2_5Ponytail", () => {
  const originalEnv = process.env.MUONROI_PONYTAIL_DISABLE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUONROI_PONYTAIL_DISABLE;
    } else {
      process.env.MUONROI_PONYTAIL_DISABLE = originalEnv;
    }
  });

  it("should apply ponytail instruction when enabled", async () => {
    process.env.MUONROI_PONYTAIL_DISABLE = "0";
    const ctx: PipelineContext = {
      raw: "test",
      enriched: "test",
      taskType: "general",
      confidence: 1,
      domain: null,
      outputStyle: "balanced",
      tokenBudget: 1000,
      metrics: null,
      layers: [],
    };

    const result = await layer2_5Ponytail(ctx);
    expect(result.layers.length).toBe(1);
    expect(result.layers[0].name).toBe("ponytail-mode");
    expect(result.layers[0].applied).toBe(true);
    expect(result.enriched).toContain("LAZY SENIOR / PONYTAIL MODE ACTIVE");
  });

  it("should skip ponytail instruction when disabled via env var", async () => {
    process.env.MUONROI_PONYTAIL_DISABLE = "1";
    const ctx: PipelineContext = {
      raw: "test",
      enriched: "test",
      taskType: "general",
      confidence: 1,
      domain: null,
      outputStyle: "balanced",
      tokenBudget: 1000,
      metrics: null,
      layers: [],
    };

    const result = await layer2_5Ponytail(ctx);
    expect(result.layers.length).toBe(1);
    expect(result.layers[0].name).toBe("ponytail-mode");
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBe("skipped:disabled-by-config");
    expect(result.enriched).toBe("test"); // Not enriched with ponytail
  });
});
