import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPilSuffix, getResponseToolSet, layer6Output } from "../layer6-output.js";
import type { OutputStyle, PipelineContext, TaskType } from "../types.js";

// Mock bridge for PIL-03 classifyViaBrain tests
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
}));

async function getMockBrain() {
  const { classifyViaBrain } = await import("../../ee/bridge.js");
  return vi.mocked(classifyViaBrain);
}

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

  it("PIL-04 Tier 1.2: appends OUTPUT BUDGET hint per task type", () => {
    const result = applyPilSuffix("S", makeCtx("debug", "concise"));
    expect(result).toMatch(/OUTPUT BUDGET: aim for ≤500 tokens/);
    const genResult = applyPilSuffix("S", makeCtx("generate", "concise"));
    expect(genResult).toMatch(/OUTPUT BUDGET: aim for ≤1200 tokens/);
  });

  it("PIL-04 Tier 1.3: appends FORBIDDEN OPENERS rule for all styles", () => {
    for (const style of ["concise", "balanced", "detailed"] as OutputStyle[]) {
      const result = applyPilSuffix("S", makeCtx("plan", style));
      expect(result).toMatch(/FORBIDDEN OPENERS/);
      expect(result).toMatch(/Tôi sẽ/); // bilingual
    }
  });

  it("PIL-04: response-tools path skips budget+preamble (tool already enforces structure)", () => {
    const result = applyPilSuffix("S", makeCtx("analyze", "balanced"), true);
    expect(result).toContain("respond_analyze");
    expect(result).not.toMatch(/OUTPUT BUDGET/);
    expect(result).not.toMatch(/FORBIDDEN OPENERS/);
  });
});

describe("getResponseToolSet — PIL-04 Tier 1.1 gating", () => {
  it("returns response tool for analyze (list-shaped, JSON wins)", () => {
    const tools = getResponseToolSet(makeCtx("analyze", null));
    expect(Object.keys(tools)).toContain("respond_analyze");
  });

  it("returns response tool for plan (list-shaped, JSON wins)", () => {
    const tools = getResponseToolSet(makeCtx("plan", null));
    expect(Object.keys(tools)).toContain("respond_plan");
  });

  it("returns empty toolset for generate (code-heavy, markdown wins)", () => {
    expect(getResponseToolSet(makeCtx("generate", null))).toEqual({});
  });

  it("returns empty toolset for refactor (diff-heavy, markdown wins)", () => {
    expect(getResponseToolSet(makeCtx("refactor", null))).toEqual({});
  });

  it("returns response tool for debug (bounded schema, structural enforcement wins)", () => {
    const tools = getResponseToolSet(makeCtx("debug", null));
    expect(Object.keys(tools)).toContain("respond_debug");
  });

  it("returns empty toolset for documentation (prose-heavy)", () => {
    expect(getResponseToolSet(makeCtx("documentation", null))).toEqual({});
  });

  it("returns empty toolset for general (plain text — DeepSeek V4 leaks special tokens into JSON; see session 528ffe653f16)", () => {
    expect(getResponseToolSet(makeCtx("general", null))).toEqual({});
  });

  it("returns empty toolset when taskType is null", () => {
    expect(getResponseToolSet(makeCtx(null, null))).toEqual({});
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

describe("layer6Output — style resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses ctx.outputStyle from L1 directly when already set — no brain call", async () => {
    const brain = await getMockBrain();
    const result = await layer6Output(makeCtx("debug", "concise"));
    expect(result.layers[0].delta).toContain("style=concise");
    expect(result.layers[0].delta).toContain("src=inherited");
    expect(brain).not.toHaveBeenCalled();
  });

  it("uses detailed style when passed from L1", async () => {
    const result = await layer6Output(makeCtx("plan", "detailed"));
    expect(result.layers[0].delta).toContain("style=detailed");
    expect(result.layers[0].delta).toContain("src=inherited");
  });

  it("when ctx.taskType is null, layer is not applied", async () => {
    const result = await layer6Output(makeCtx(null, null));
    expect(result.layers[0].applied).toBe(false);
  });

  it("PIL-03a: rescues outputStyle via brain when L1 returns null", async () => {
    const brain = await getMockBrain();
    brain.mockResolvedValueOnce("detailed");
    const result = await layer6Output(makeCtx("plan", null));
    expect(result.outputStyle).toBe("detailed");
    expect(result.layers[0].delta).toContain("style=detailed");
    expect(result.layers[0].delta).toContain("src=brain-rescue");
  });

  it("PIL-03b: uses task-type heuristic when brain returns null (debug→balanced)", async () => {
    const result = await layer6Output(makeCtx("debug", null));
    expect(result.outputStyle).toBe("balanced");
    expect(result.layers[0].delta).toContain("style=balanced");
    expect(result.layers[0].delta).toContain("src=task-heuristic");
  });

  it("PIL-03b: task-heuristic for plan→balanced (not detailed — avoids generating extra sections)", async () => {
    const result = await layer6Output(makeCtx("plan", null));
    expect(result.outputStyle).toBe("balanced");
    expect(result.layers[0].delta).toContain("style=balanced");
  });

  it("PIL-03b: task-heuristic for generate→concise", async () => {
    const result = await layer6Output(makeCtx("generate", null));
    expect(result.outputStyle).toBe("concise");
    expect(result.layers[0].delta).toContain("style=concise");
  });

  it("PIL-03b: task-heuristic for refactor→concise", async () => {
    const result = await layer6Output(makeCtx("refactor", null));
    expect(result.outputStyle).toBe("concise");
  });

  it("skips classifyViaBrain rescue when ctx._brainData is populated (style guaranteed by L1)", async () => {
    const brain = await getMockBrain();
    brain.mockClear();
    const ctx: PipelineContext = {
      ...makeCtx("plan", "balanced"),
      _brainData: { t0_principles: [], t1_rules: [], t2_patterns: [], retrieval_skipped_reason: null },
    };
    await layer6Output(ctx);
    expect(brain).not.toHaveBeenCalled();
  });

  it("PIL-03: resolved outputStyle propagated back onto ctx", async () => {
    const result = await layer6Output(makeCtx("analyze", null));
    expect(result.outputStyle).not.toBeNull();
    expect(result.outputStyle).toBe("balanced");
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

  it("chitchat short-circuit: skips suffix work, marks delta=skip:chitchat", async () => {
    const brain = await getMockBrain();
    const ctx: PipelineContext = { ...makeCtx("general", "concise"), intentKind: "chitchat" };
    const result = await layer6Output(ctx);
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBe("skip:chitchat");
    expect(brain).not.toHaveBeenCalled();
  });

  it("applyPilSuffix: returns prompt unchanged when intentKind=chitchat", () => {
    const ctx: PipelineContext = { ...makeCtx("general", "concise"), intentKind: "chitchat" };
    const system = "SYSTEM";
    expect(applyPilSuffix(system, ctx)).toBe(system);
  });

  it("enriched unchanged (Layer 6 modifies system prompt only)", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const ctx = makeCtx("generate");
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
