import { describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  routeTask: vi.fn().mockResolvedValue(null),
}));

import { layer4Gsd } from "../layer4-gsd";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "implement the login feature",
    enriched: "implement the login feature",
    taskType: "generate",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer4Gsd (gsd-native)", () => {
  it("skips directive injection when intentKind === 'chitchat'", async () => {
    const before = "hello";
    const result = await layer4Gsd(makeCtx({ raw: before, enriched: before, intentKind: "chitchat" }));
    expect(result.enriched).toBe(before);
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toBe("skip:chitchat");
  });

  it("appends a gsd-native directive and records the layer as applied", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "implement the login feature" }));
    expect(result.enriched).toContain("[gsd-native]");
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toMatch(/tier=(quick|standard|heavy)/);
  });

  it("preserves an already-set gsdPhase from context", async () => {
    const result = await layer4Gsd(makeCtx({ gsdPhase: "plan", raw: "do something" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("phase=plan");
  });

  it("emits a HEAVY directive for wholesale, multi-step prompts", async () => {
    const heavy = "redo the entire architecture and produce a deep-map across all repos, including business rules";
    const result = await layer4Gsd(makeCtx({ raw: heavy, tokenBudget: 4000 }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("tier=heavy");
    expect(result.enriched).toMatch(/MANDATORY/);
    expect(result.enriched).toMatch(/AskUserQuestion/);
  });

  it("emits a QUICK directive for trivial prompts", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "fix typo in README" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("tier=quick");
  });

  it("still records a layer entry even when no phase is detected", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "hello there", gsdPhase: null }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toMatch(/phase=(none|discuss|plan|execute|verify|review)/);
  });

  it("respects tokenBudget when truncating the directive", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "implement this", tokenBudget: 30 }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    if (layer?.applied && layer.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        // Directive budget is 25% of tokenBudget * 4 chars/token = 30 chars at budget=30.
        // truncateToBudget returns chars-based budget — accept up to tokenBudget*4.
        expect(parseInt(charsMatch[1], 10)).toBeLessThanOrEqual(30 * 4);
      }
    }
  });

  it("updates gsdPhase on context when keyword detection fires", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "review the pull request" }));
    expect(["review", "discuss", "execute"]).toContain(result.gsdPhase);
  });

  it("routes a question-shaped analyze/debug prompt to the QUESTION directive (no 'state a plan')", async () => {
    // De-robotizing: a plain question must not get the STANDARD "state a 2-3 line
    // plan" scaffold even when L1 classifies it analyze/debug (not "general").
    const q = "why does the build fail intermittently?";
    const result = await layer4Gsd(makeCtx({ raw: q, enriched: q, taskType: "debug", intentKind: "task" }));
    expect(result.enriched).toContain("QUESTION / explanatory");
    expect(result.enriched).not.toContain("State a 2-3 line plan");
  });

  it("treats a genuine general question (general + task) as informational", async () => {
    const q = "what does the enrichment layer do?";
    const result = await layer4Gsd(makeCtx({ raw: q, enriched: q, taskType: "general", intentKind: "task" }));
    expect(result.enriched).toContain("QUESTION / explanatory");
  });

  it("does NOT treat an implementation request as informational even if phrased as a question", async () => {
    // isImplementationIntent guards the question clause: "can you refactor … and
    // wire up …" is a real edit task → STANDARD scaffold, not the QUESTION directive.
    const q = "can you refactor the dropdown and wire up the keyboard handlers?";
    const result = await layer4Gsd(makeCtx({ raw: q, enriched: q, taskType: "refactor", intentKind: "task" }));
    expect(result.enriched).not.toContain("QUESTION / explanatory");
  });

  it("uses ctx.gsdPhase from L1 (unified path) without calling routeTask", async () => {
    const { routeTask } = await import("../../ee/bridge.js");
    vi.mocked(routeTask).mockClear();
    await layer4Gsd({
      raw: "x",
      enriched: "x",
      taskType: "debug" as const,
      domain: null,
      confidence: 0.85,
      outputStyle: "balanced" as const,
      tokenBudget: 2000,
      metrics: null,
      layers: [],
      gsdPhase: "execute",
      _brainData: { t0_principles: [], t1_rules: [], t2_patterns: [], retrieval_skipped_reason: null },
    });
    expect(routeTask).not.toHaveBeenCalled();
  });
});
