import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSubAgentStepData,
  isSubAgentStepMeterEnabled,
  parseStepCacheUsage,
  stepHitPct,
} from "../subagent-step-meter.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseStepCacheUsage — multi-provider shape tolerance", () => {
  it("reads the AI-SDK v6 normalized shape (cachedInputTokens)", () => {
    const u = parseStepCacheUsage({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 400 });
    expect(u).toEqual({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, cacheCreationTokens: 0 });
  });

  it("reads inputTokenDetails.cacheReadTokens / cacheWriteTokens", () => {
    const u = parseStepCacheUsage({
      inputTokens: 2000,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 1500, cacheWriteTokens: 300 },
    });
    expect(u.cacheReadTokens).toBe(1500);
    expect(u.cacheCreationTokens).toBe(300);
  });

  it("reads provider raw passthrough (deepseek prompt_cache_hit_tokens)", () => {
    const u = parseStepCacheUsage({
      inputTokens: 5000,
      raw: { prompt_cache_hit_tokens: 2500, cache_creation_input_tokens: 100 },
    });
    expect(u.cacheReadTokens).toBe(2500);
    expect(u.cacheCreationTokens).toBe(100);
  });

  it("falls back to promptTokens/completionTokens naming", () => {
    const u = parseStepCacheUsage({ promptTokens: 800, completionTokens: 40 });
    expect(u.inputTokens).toBe(800);
    expect(u.outputTokens).toBe(40);
  });

  it("defaults every field to 0 for empty / non-object usage", () => {
    for (const bad of [undefined, null, {}, 42, "x"]) {
      expect(parseStepCacheUsage(bad)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    }
  });

  it("prefers the normalized field over raw when both present", () => {
    const u = parseStepCacheUsage({
      inputTokens: 1000,
      cachedInputTokens: 900,
      raw: { prompt_cache_hit_tokens: 100 },
    });
    expect(u.cacheReadTokens).toBe(900);
  });
});

describe("stepHitPct", () => {
  it("computes a one-decimal percentage", () => {
    expect(stepHitPct({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 456, cacheCreationTokens: 0 })).toBe(45.6);
  });
  it("is 0 when there is no input (no divide-by-zero)", () => {
    expect(stepHitPct({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });
});

describe("buildSubAgentStepData", () => {
  it("merges the parsed usage with stepIndex/callId and derives hitPct", () => {
    const data = buildSubAgentStepData(
      { inputTokens: 2000, outputTokens: 20, cachedInputTokens: 500 },
      { stepIndex: 3, callId: "sub-abc" },
    );
    expect(data).toEqual({
      inputTokens: 2000,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
      stepIndex: 3,
      callId: "sub-abc",
      hitPct: 25,
    });
  });
});

describe("isSubAgentStepMeterEnabled", () => {
  it("defaults ON, disabled only by exactly '0'", () => {
    expect(isSubAgentStepMeterEnabled()).toBe(true);
    vi.stubEnv("MUONROI_SUBAGENT_STEP_METER", "0");
    expect(isSubAgentStepMeterEnabled()).toBe(false);
    vi.stubEnv("MUONROI_SUBAGENT_STEP_METER", "1");
    expect(isSubAgentStepMeterEnabled()).toBe(true);
    vi.stubEnv("MUONROI_SUBAGENT_STEP_METER", "false");
    expect(isSubAgentStepMeterEnabled()).toBe(true); // only "0" disables
  });
});
