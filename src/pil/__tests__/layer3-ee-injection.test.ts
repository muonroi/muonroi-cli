import { beforeEach, describe, expect, test, vi } from "vitest";
import { layer3EeInjection } from "../layer3-ee-injection";
import type { PipelineContext } from "../types";

vi.mock("../../ee/bridge.js", () => ({
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
}));

import { getEmbeddingRaw, searchCollection } from "../../ee/bridge.js";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "debug the login flow",
    enriched: "debug the login flow",
    taskType: "debug",
    domain: null,
    confidence: 0.85,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer3EeInjection (bridge-based)", () => {
  beforeEach(() => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue(null);
    vi.mocked(searchCollection).mockResolvedValue([]);
  });

  test("Test 1: returns enriched context with hints when getEmbeddingRaw returns vector and searchCollection returns points with payload.text", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(searchCollection).mockResolvedValue([
      { id: "abc1", score: 0.92, payload: { text: "Always check null before accessing .user" } },
      { id: "def2", score: 0.88, payload: { text: "Use try-catch around DB calls" } },
    ]);

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("[experience:");
    expect(result.enriched).toContain("Always check null before accessing .user");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
  });

  test("Test 2: returns ctx unchanged with applied=false and delta=no-embedding when getEmbeddingRaw returns null", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue(null);

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toContain("no-embedding");
  });

  test("Test 3: returns ctx unchanged with applied=false and delta=no-points when searchCollection returns []", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(searchCollection).mockResolvedValue([]);

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toBe("no-points");
  });

  test("Test 4: extracts text from payload.json containing solution field", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(searchCollection).mockResolvedValue([
      { id: "xyz9", score: 0.75, payload: { json: JSON.stringify({ solution: "Always validate inputs at boundary" }) } },
    ]);

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("Always validate inputs at boundary");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
  });

  test("Test 5: hints are truncated via truncateToBudget at 30% of tokenBudget", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue([0.1, 0.2, 0.3]);
    const longText = "A".repeat(2000);
    vi.mocked(searchCollection).mockResolvedValue([
      { id: "x", score: 0.9, payload: { text: longText } },
    ]);

    const result = await layer3EeInjection(makeCtx({ tokenBudget: 100 }));
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        // 30% of 100 tokens * 4 chars/token = 120 chars max; +3 for possible "..." suffix
        expect(chars).toBeLessThanOrEqual(123);
      }
    }
  });

  test("Test 6: collection name is always 'experience-behavioral' regardless of taskType", async () => {
    vi.mocked(getEmbeddingRaw).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(searchCollection).mockResolvedValue([]);

    await layer3EeInjection(makeCtx({ taskType: "refactor" }));
    expect(vi.mocked(searchCollection)).toHaveBeenCalledWith(
      "experience-behavioral",
      expect.any(Array),
      expect.any(Number),
      expect.any(Object),
    );
  });
});
