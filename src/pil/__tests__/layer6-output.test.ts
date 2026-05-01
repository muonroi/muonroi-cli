import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyPilSuffix, layer6Output } from "../layer6-output.js";
import type { OutputStyle, PipelineContext, TaskType } from "../types.js";

// Mock bridge for PIL-03 classifyViaBrain tests
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
}));

const makeCtx = (taskType: TaskType | null = null, outputStyle: OutputStyle | null = null): PipelineContext => ({
  raw: "test prompt for output style detection",
  enriched: "test prompt for output style detection",
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

describe("layer6Output — PIL-03 bridge output style detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when ctx.outputStyle is null and ctx.taskType is not null, classifyViaBrain is called", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    await layer6Output(makeCtx("debug", null));

    expect(classifyViaBrain).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(classifyViaBrain).mock.calls[0];
    expect(callArgs[0]).toContain("Analyze this prompt");
    expect(callArgs[1]).toBe(50); // 50ms timeout
  });

  it("when classifyViaBrain returns 'concise', ctx.outputStyle is set to 'concise'", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue("concise");

    const result = await layer6Output(makeCtx("debug", null));

    expect(result.outputStyle).toBe("concise");
  });

  it("when classifyViaBrain returns null (timeout), ctx.outputStyle stays null (fail-open)", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx("debug", null));

    expect(result.outputStyle).toBeNull();
  });

  it("when ctx.outputStyle is already set, classifyViaBrain is NOT called", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx("debug", "detailed"));

    expect(classifyViaBrain).not.toHaveBeenCalled();
    expect(result.outputStyle).toBe("detailed");
  });

  it("when ctx.taskType is null, classifyViaBrain is NOT called", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx(null, null));

    expect(classifyViaBrain).not.toHaveBeenCalled();
    expect(result.layers[0].applied).toBe(false);
  });

  it("brain returns partial match — 'this should be detailed response' → detects 'detailed'", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue("this should be detailed response");

    const result = await layer6Output(makeCtx("plan", null));

    expect(result.outputStyle).toBe("detailed");
  });
});

describe("layer6Output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with taskType=debug — applied=true, delta contains suffix=debug and style", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx("debug", "concise"));
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=debug/);
    expect(result.layers[0].delta).toMatch(/style=concise/);
    expect(result.layers[0].delta).toMatch(/chars=\d+/);
  });

  it("with taskType=refactor — applied=true, delta contains suffix=refactor", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

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
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const ctx = makeCtx("generate");
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
