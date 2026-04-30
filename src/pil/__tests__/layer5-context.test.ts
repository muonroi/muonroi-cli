import { describe, expect, it } from "vitest";
import { layer5Context } from "../layer5-context";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "continue working on the auth module",
    enriched: "continue working on the auth module",
    taskType: "refactor",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer5Context", () => {
  it("injects resume digest when available", async () => {
    const digest = "Last session: refactored auth middleware, JWT validation working, need to add refresh token logic.";
    const result = await layer5Context(makeCtx({ resumeDigest: digest }));
    expect(result.enriched).toContain("[flow-context:");
    expect(result.enriched).toContain("refactored auth middleware");
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("chars=");
  });

  it("skips when resumeDigest is null", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: null }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(result.enriched).toBe(makeCtx().enriched);
  });

  it("skips when resumeDigest is undefined", async () => {
    const result = await layer5Context(makeCtx());
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(false);
  });

  it("skips when resumeDigest is empty string", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "" }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(false);
  });

  it("includes activeRunId in delta when present", async () => {
    const result = await layer5Context(
      makeCtx({ resumeDigest: "Some digest", activeRunId: "abc123" }),
    );
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.delta).toContain("runId=abc123");
  });

  it("respects tokenBudget — truncates long digest", async () => {
    const longDigest = "Context: ".repeat(500);
    const result = await layer5Context(makeCtx({ resumeDigest: longDigest, tokenBudget: 50 }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        expect(parseInt(charsMatch[1], 10)).toBeLessThanOrEqual(50 * 4);
      }
    }
  });

  it("preserves existing enriched content", async () => {
    const result = await layer5Context(
      makeCtx({
        enriched: "already enriched prompt\n[personality: concise]",
        resumeDigest: "Previous session work",
      }),
    );
    expect(result.enriched).toContain("already enriched prompt");
    expect(result.enriched).toContain("[flow-context:");
  });
});
