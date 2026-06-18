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

describe("layer4Gsd (playbook)", () => {
  it("skips directive injection when intentKind === 'chitchat'", async () => {
    const before = "hello";
    const result = await layer4Gsd(makeCtx({ raw: before, enriched: before, intentKind: "chitchat" }));
    expect(result.enriched).toBe(before);
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toBe("skip:chitchat");
  });

  it("appends a playbook directive and records the layer as applied", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "implement the login feature" }));
    expect(result.enriched).toContain("[playbook]");
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

  it("emits a HEAVY directive when the model classifies depth=heavy (agent-first, not regex)", async () => {
    // Depth now comes from ctx.modelDepthTier (the model's 5th classify word),
    // NOT a regex scan of the raw prompt. A plainly-phrased prompt the model
    // judged heavy still gets the full discuss → research → check-plan flow.
    const result = await layer4Gsd(
      makeCtx({ raw: "rework how auth works", tokenBudget: 8000, modelDepthTier: "heavy" }),
    );
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("tier=heavy");
    expect(layer!.delta).toContain("depth=model");
    expect(result.enriched).toMatch(/HEAVY task/);
    expect(result.enriched).toMatch(/DISCUSS/);
    expect(result.enriched).toMatch(/AskUserQuestion/);
    expect(result.enriched).toMatch(/CHECK-PLAN/);
  });

  it("emits a QUICK directive when the model classifies depth=quick", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "fix typo in README", modelDepthTier: "quick" }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("tier=quick");
    expect(layer!.delta).toContain("depth=model");
  });

  it("defaults to STANDARD tier when the model supplied no depth (no regex fallback)", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "do the thing", modelDepthTier: null }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("tier=standard");
    expect(layer!.delta).toContain("depth=default");
  });

  it("still records a layer entry even when no phase is detected", async () => {
    const result = await layer4Gsd(makeCtx({ raw: "hello there", gsdPhase: null }));
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
    expect(layer!.delta).toMatch(/phase=(none|discuss|plan|execute|verify|review)/);
  });

  it("floors the directive budget so the rubric survives at the default tokenBudget (regression: directive was truncated to ~500 chars)", async () => {
    // The playbook directive is a critical behavioural instruction and must NOT
    // be gutted by the tiny pipeline budget. At the production default
    // tokenBudget=500 the bare 25% fraction was ~500 chars, which cut the HEAVY
    // rubric after step 1. The floor (DIRECTIVE_MIN_TOKENS) guarantees the full
    // ~1.7K-char HEAVY rubric reaches the model intact.
    const result = await layer4Gsd(makeCtx({ raw: "rework auth", tokenBudget: 500, modelDepthTier: "heavy" }));
    expect(result.enriched).toMatch(/DISCUSS/);
    expect(result.enriched).toMatch(/CHECK-PLAN/);
    expect(result.enriched).toMatch(/VERIFY/);
    expect(result.enriched).toMatch(/todo_write/);
  });

  it("does NOT keyword-detect a phase from the raw prompt (agent-first, no regex)", async () => {
    // Phase keyword detection was removed: a regex scan of the prompt would
    // mislabel the directive. Phase is sourced only from ctx.gsdPhase (L1
    // unified) or the EE brain route. With neither, it stays null/undefined.
    const result = await layer4Gsd(makeCtx({ raw: "review the pull request" }));
    expect(result.gsdPhase ?? null).toBeNull();
    const layer = result.layers.find((l) => l.name === "gsd-workflow-structuring");
    expect(layer!.delta).toContain("phase=none");
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

  it("Phase 2b: deliverableKind='answer' is informational even for an imperative (no '?') prompt", async () => {
    // The raw text is a plain imperative — the legacy regex (isQuestionLike /
    // isMetaAnalysisPrompt) would NOT mark it informational. The model's
    // deliverableKind='answer' must override that and route to the QUESTION
    // directive — proving L4 consumes the model signal, not the regex.
    const raw = "go over the auth module and tell me what it does";
    const result = await layer4Gsd(
      makeCtx({ raw, enriched: raw, taskType: "analyze", intentKind: "task", deliverableKind: "answer" }),
    );
    expect(result.enriched).toContain("QUESTION / explanatory");
  });

  it("deliverableKind='report' is informational (no council/discuss scaffold) — session 666630479c1a", async () => {
    // "Đọc và tóm tắt kiến trúc…" classifies as deliverableKind 'report'. A
    // report is human-facing with NO code change, so it must route to the
    // QUESTION directive, not the heavy implement/discuss/council scaffold that
    // over-asked with askcards on a read/summarize task.
    const raw = "đọc và tóm tắt kiến trúc src/orchestrator, src/pil, src/mcp kèm file:line";
    const result = await layer4Gsd(
      makeCtx({ raw, enriched: raw, taskType: "analyze", intentKind: "task", deliverableKind: "report" }),
    );
    expect(result.enriched).toContain("QUESTION / explanatory");
    expect(result.enriched).not.toContain("MANDATORY");
  });

  it("Phase 2b: deliverableKind='code' is NOT informational even for a question-shaped prompt", async () => {
    // The raw text reads as a question — the legacy regex would mark it
    // informational. The model's deliverableKind='code' must override that so
    // the STANDARD implement scaffold is used (the deliverable is file edits).
    const raw = "why not just refactor the dropdown and wire the keyboard handlers?";
    const result = await layer4Gsd(
      makeCtx({ raw, enriched: raw, taskType: "refactor", intentKind: "task", deliverableKind: "code" }),
    );
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
