import { describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "../types";

vi.mock("../../ee/bridge.js", () => ({
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  searchByText: vi.fn().mockResolvedValue([]),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockRejectedValue(new Error("not found")),
      readdir: vi.fn().mockRejectedValue(new Error("not found")),
      stat: vi.fn().mockRejectedValue(new Error("not found")),
    },
  };
});

import { layer5Context } from "../layer5-context";

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
  it("skips workspace context when intentKind === 'chitchat'", async () => {
    const before = "hi";
    const result = await layer5Context(
      makeCtx({
        raw: before,
        enriched: before,
        intentKind: "chitchat",
        resumeDigest: "should be ignored on chitchat",
      }),
    );
    expect(result.enriched).toBe(before);
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toBe("skip:chitchat");
  });

  it("injects resume digest when available", async () => {
    const digest = "Last session: refactored auth middleware, JWT validation working, need to add refresh token logic.";
    const result = await layer5Context(makeCtx({ resumeDigest: digest }));
    expect(result.enriched).toContain("[flow-context:");
    expect(result.enriched).toContain("refactored auth middleware");
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("digest=");
  });

  it("no digest, no EE, no flow → applied=false", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: null }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
  });

  it("no digest undefined → applied=false (with mocked EE)", async () => {
    const result = await layer5Context(makeCtx());
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(false);
  });

  it("empty digest → applied=false (with mocked EE)", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "" }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(false);
  });

  it("includes digest in delta when present", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "Some digest", activeRunId: "abc123" }));
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toContain("digest=");
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

  it("adds stale warning when digest is older than 30 minutes", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "Previous work on auth", digestAgeMs: 60 * 60 * 1000 }));
    expect(result.enriched).toContain("stale");
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.delta).toContain("stale");
  });

  it("no stale warning when digest is fresh", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "Recent work", digestAgeMs: 5 * 60 * 1000 }));
    expect(result.enriched).not.toContain("stale");
  });

  it("no stale warning when digestAgeMs is undefined", async () => {
    const result = await layer5Context(makeCtx({ resumeDigest: "Some work" }));
    expect(result.enriched).not.toContain("stale");
  });

  it("skips fetchPrinciples when ctx._brainData already supplied them", async () => {
    const { searchByText } = await import("../../ee/bridge.js");
    vi.mocked(searchByText).mockClear();
    const { layer5Context } = await import("../layer5-context.js");
    await layer5Context({
      raw: "x",
      enriched: "x",
      taskType: "debug" as const,
      domain: null,
      confidence: 0.85,
      outputStyle: "balanced" as const,
      tokenBudget: 2000,
      metrics: null,
      layers: [],
      _brainData: {
        t0_principles: [{ text: "p", score: 0.9 }],
        t1_rules: [],
        t2_patterns: [],
        retrieval_skipped_reason: null,
      },
    });
    expect(searchByText).not.toHaveBeenCalled();
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
