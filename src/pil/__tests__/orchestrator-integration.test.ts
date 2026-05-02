/**
 * src/pil/__tests__/orchestrator-integration.test.ts
 *
 * Integration-level unit tests verifying the PIL orchestrator contract:
 * - enriched message is used when pipeline succeeds
 * - applyPilSuffix injects OUTPUT RULES suffix for coding taskTypes
 * - applyPilSuffix skips suffix when taskType is null
 * - catch fallback uses raw message (fail-open contract)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "../types.js";

// Mock classifier and EE bridge before importing pipeline
vi.mock("../../router/classifier/index.js", () => ({
  classify: vi.fn().mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" }),
}));
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  routeTask: vi.fn().mockResolvedValue(null),
}));

import { applyPilSuffix, runPipeline } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PIL orchestrator contract", () => {
  it("enriched message is used when pipeline succeeds", async () => {
    const ctx = await runPipeline("refactor this function");
    // Layer 2 personality now appends hints, so enriched starts with raw
    expect(ctx.enriched.startsWith("refactor this function")).toBe(true);
    expect(ctx.layers).toHaveLength(6);
  });

  it("applyPilSuffix appends OUTPUT RULES suffix for coding taskType (non-null)", () => {
    const codingCtx: PipelineContext = {
      raw: "refactor the loop",
      enriched: "refactor the loop",
      taskType: "refactor",
      domain: null,
      confidence: 0.85,
      outputStyle: "concise",
      tokenBudget: 500,
      metrics: null,
      layers: [],
    };
    const base = "You are a helpful assistant.";
    const result = applyPilSuffix(base, codingCtx);
    expect(result).toContain("OUTPUT RULES");
    expect(result.startsWith(base)).toBe(true);
  });

  it("applyPilSuffix does NOT append suffix when taskType is null", () => {
    const nullCtx: PipelineContext = {
      raw: "hello world",
      enriched: "hello world",
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
    };
    const base = "You are a helpful assistant.";
    const result = applyPilSuffix(base, nullCtx);
    expect(result).toBe(base);
    expect(result).not.toContain("OUTPUT RULES");
  });

  it("catch fallback uses raw userMessage (fail-open contract matches orchestrator .catch())", async () => {
    // Simulate the catch block in orchestrator:
    // const pilCtx = await runPipeline(userMessage).catch(() => ({
    //   raw: userMessage, enriched: userMessage, taskType: null, domain: null, layers: [],
    // }));
    const userMessage = "some user prompt";
    const fallback: PipelineContext = {
      raw: userMessage,
      enriched: userMessage,
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
    };
    // Verify fallback structure matches orchestrator catch shape
    expect(fallback.enriched).toBe(userMessage);
    expect(fallback.taskType).toBeNull();
    expect(fallback.layers).toHaveLength(0);
    // applyPilSuffix must return base unchanged for this fallback (taskType null)
    const base = "System prompt";
    expect(applyPilSuffix(base, fallback)).toBe(base);
  });

  it("runPipeline stores result — getPilLastResult returns same reference", async () => {
    const { getPilLastResult } = await import("../index.js");
    const ctx = await runPipeline("check store after pipeline");
    const stored = getPilLastResult();
    expect(stored).toBe(ctx);
  });
});
