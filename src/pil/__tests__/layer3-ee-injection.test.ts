import { describe, expect, test, vi, beforeEach } from "vitest";
import { layer3EeInjection } from "../layer3-ee-injection";
import type { PipelineContext } from "../types";

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

describe("layer3EeInjection", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ points: [] }), { status: 200 }),
      ),
    ) as any;
  });

  test("passes through when EE returns no points", async () => {
    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(result.enriched).toBe(ctx.enriched);
  });

  test("injects experience hints when EE returns points", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            points: [
              { id: "abc1", text: "Always check null before accessing .user", score: 0.92, collection: "patterns" },
              { id: "def2", text: "Use try-catch around DB calls", score: 0.88, collection: "patterns" },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("[experience:");
    expect(result.enriched).toContain("null");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
  });

  test("respects tokenBudget — truncates if needed", async () => {
    const longText = "A".repeat(2000);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            points: [{ id: "x", text: longText, score: 0.9, collection: "patterns" }],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await layer3EeInjection(makeCtx({ tokenBudget: 100 }));
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        expect(chars).toBeLessThanOrEqual(100 * 4);
      }
    }
  });

  test("fails open on network error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as any;

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toContain("error");
  });

  test("fails open on non-200 response", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as any;

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(false);
  });
});
