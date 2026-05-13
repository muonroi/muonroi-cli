import { describe, expect, it } from "vitest";
import {
  OutputStyleSchema,
  PilContextResponseSchema,
  PipelineContextSchema,
  PipelineMetricsSchema,
  TaskTypeSchema,
} from "../schema.js";

describe("PipelineContextSchema", () => {
  const validCtx = {
    raw: "test",
    enriched: "test",
    taskType: "refactor" as const,
    domain: null,
    confidence: 0.85,
    outputStyle: "concise" as const,
    tokenBudget: 500,
    metrics: null,
    layers: [{ name: "intent-detection", applied: true, delta: "taskType=refactor" }],
  };

  it("accepts valid PipelineContext", () => {
    const result = PipelineContextSchema.safeParse(validCtx);
    expect(result.success).toBe(true);
  });

  it("accepts null taskType and outputStyle", () => {
    const result = PipelineContextSchema.safeParse({
      ...validCtx,
      taskType: null,
      outputStyle: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects confidence > 1", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid taskType", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, taskType: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid outputStyle", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, outputStyle: "verbose" });
    expect(result.success).toBe(false);
  });

  it("rejects tokenBudget <= 0", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, tokenBudget: 0 });
    expect(result.success).toBe(false);
  });

  it("safeParse never throws", () => {
    expect(() => PipelineContextSchema.safeParse(null)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse(undefined)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse(42)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse("string")).not.toThrow();
  });

  it("accepts valid metrics object", () => {
    const result = PipelineContextSchema.safeParse({
      ...validCtx,
      metrics: {
        totalMs: 5,
        layerTimings: [{ name: "l1", ms: 2 }],
        inputChars: 10,
        outputChars: 10,
        suffixInstructionTokens: 20,
        enrichmentTokensAdded: 0,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts null metrics", () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, metrics: null });
    expect(result.success).toBe(true);
  });
});

describe("PipelineMetricsSchema", () => {
  it("accepts valid metrics", () => {
    const result = PipelineMetricsSchema.safeParse({
      totalMs: 10,
      layerTimings: [],
      inputChars: 5,
      outputChars: 5,
      suffixInstructionTokens: 0,
      enrichmentTokensAdded: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative totalMs", () => {
    const result = PipelineMetricsSchema.safeParse({
      totalMs: -1,
      layerTimings: [],
      inputChars: 0,
      outputChars: 0,
      suffixInstructionTokens: 0,
      enrichmentTokensAdded: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("TaskTypeSchema", () => {
  it.each(["refactor", "debug", "plan", "analyze", "documentation", "generate"])("accepts %s", (t) => {
    expect(TaskTypeSchema.safeParse(t).success).toBe(true);
  });

  it("rejects unknown type", () => {
    expect(TaskTypeSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("OutputStyleSchema", () => {
  it.each(["concise", "detailed", "balanced"])("accepts %s", (s) => {
    expect(OutputStyleSchema.safeParse(s).success).toBe(true);
  });

  it("rejects unknown style", () => {
    expect(OutputStyleSchema.safeParse("verbose").success).toBe(false);
  });
});

describe("PilContextResponseSchema", () => {
  const validResponse = {
    taskType: "debug",
    intentKind: "task",
    outputStyle: "balanced",
    confidence: 0.85,
    domain: "typescript",
    gsd_phase: "execute",
    gsd_route_source: "ee",
    t0_principles: [{ text: "principle one", score: 0.9 }],
    t1_rules: ["always run tests after edit"],
    t2_patterns: [{ text: "pattern one", score: 0.7 }],
    retrieval_skipped_reason: null,
    cache_hit: false,
    inference_ms: 1234,
    schema_version: "1.0",
  };

  it("accepts a complete valid response", () => {
    const result = PilContextResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it("accepts nullable taskType / intentKind / domain / gsd_phase", () => {
    const r = PilContextResponseSchema.safeParse({
      ...validResponse,
      taskType: null,
      intentKind: null,
      domain: null,
      gsd_phase: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects when outputStyle is missing (must always be provided)", () => {
    const { outputStyle, ...rest } = validResponse;
    void outputStyle;
    const r = PilContextResponseSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects when confidence is out of [0,1]", () => {
    const r = PilContextResponseSchema.safeParse({ ...validResponse, confidence: 1.5 });
    expect(r.success).toBe(false);
  });

  it("rejects when schema_version is missing", () => {
    const { schema_version, ...rest } = validResponse;
    void schema_version;
    const r = PilContextResponseSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("ignores unknown fields (forward-compat for v1.1)", () => {
    const r = PilContextResponseSchema.safeParse({ ...validResponse, whoami_directives: ["x"] });
    expect(r.success).toBe(true);
  });
});
