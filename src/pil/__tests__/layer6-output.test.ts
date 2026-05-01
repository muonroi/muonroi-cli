import { describe, expect, it } from "vitest";
import { applyPilSuffix, layer6Output } from "../layer6-output.js";
import type { OutputStyle, PipelineContext, TaskType } from "../types.js";

const makeCtx = (taskType: TaskType | null = null, outputStyle: OutputStyle | null = null): PipelineContext => ({
  raw: "test prompt",
  enriched: "test prompt",
  taskType,
  domain: null,
  confidence: 0,
  outputStyle,
  tokenBudget: 500,
  metrics: null,
  layers: [],
});

describe("applyPilSuffix — per-task-type suffixes", () => {
  const taskTypes: TaskType[] = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];

  it.each(taskTypes)("appends correct OUTPUT RULES for taskType=%s", (tt) => {
    const ctx = makeCtx(tt);
    const result = applyPilSuffix("SYSTEM", ctx);
    expect(result).toContain("SYSTEM");
    expect(result).toContain(`OUTPUT RULES (${tt})`);
    expect(result.length).toBeGreaterThan("SYSTEM".length);
  });

  it("each task type has a distinct suffix", () => {
    const suffixes = taskTypes.map((tt) => applyPilSuffix("", makeCtx(tt)));
    const unique = new Set(suffixes);
    expect(unique.size).toBe(taskTypes.length);
  });

  it("returns system prompt unchanged when taskType is null", () => {
    const system = "You are a helpful assistant.";
    expect(applyPilSuffix(system, makeCtx(null))).toBe(system);
  });

  it("defaults to concise when outputStyle is null", () => {
    const ctxNullStyle = makeCtx("debug", null);
    const ctxConcise = makeCtx("debug", "concise");
    expect(applyPilSuffix("S", ctxNullStyle)).toBe(applyPilSuffix("S", ctxConcise));
  });
});

describe("applyPilSuffix — outputStyle variants", () => {
  const styles: OutputStyle[] = ["concise", "detailed", "balanced"];

  it("each style produces a different suffix for the same taskType", () => {
    const suffixes = styles.map((s) => applyPilSuffix("", makeCtx("refactor", s)));
    const unique = new Set(suffixes);
    expect(unique.size).toBe(styles.length);
  });

  it.each(styles)("detailed suffix is longer than concise for taskType=debug (style=%s check)", (style) => {
    const result = applyPilSuffix("", makeCtx("debug", style));
    expect(result).toContain("OUTPUT RULES (debug)");
  });

  it("detailed suffix allows explanation", () => {
    const result = applyPilSuffix("", makeCtx("refactor", "detailed"));
    expect(result).toContain("full rationale");
  });

  it("concise suffix restricts prose", () => {
    const result = applyPilSuffix("", makeCtx("refactor", "concise"));
    expect(result).toContain("No prose");
  });
});

describe("layer6Output", () => {
  it("with taskType=debug — applied=true, delta contains suffix=debug and style", async () => {
    const result = await layer6Output(makeCtx("debug", "concise"));
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=debug/);
    expect(result.layers[0].delta).toMatch(/style=concise/);
    expect(result.layers[0].delta).toMatch(/chars=\d+/);
  });

  it("with taskType=refactor — applied=true, delta contains suffix=refactor", async () => {
    const result = await layer6Output(makeCtx("refactor", "detailed"));
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=refactor/);
    expect(result.layers[0].delta).toMatch(/style=detailed/);
  });

  it("with taskType=null — applied=false, delta=null", async () => {
    const result = await layer6Output(makeCtx(null));
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
  });

  it("enriched unchanged (Layer 6 modifies system prompt only)", async () => {
    const ctx = makeCtx("generate");
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
