import { beforeEach, describe, expect, test, vi } from "vitest";
import { sessionRecallLedger } from "../../ee/recall-ledger";
import { layer3EeInjection, RECALL_FEEDBACK_NUDGE } from "../layer3-ee-injection";
import type { PipelineContext } from "../types";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import { searchByText } from "../../ee/bridge.js";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "debug the login flow",
    enriched: "debug the login flow",
    taskType: "debug",
    domain: null,
    confidence: 0.85,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer3EeInjection (bridge-based)", () => {
  beforeEach(() => {
    vi.mocked(searchByText).mockReset();
    vi.mocked(searchByText).mockResolvedValue([]);
    // The recall-feedback ledger is a process singleton; reset so passive-injection
    // debt recorded by one test does not lengthen the pending reminder in the next.
    sessionRecallLedger.reset();
  });

  test("Test 1: returns enriched context with hints when searchByText returns points with payload.text", async () => {
    vi.mocked(searchByText).mockResolvedValue([
      {
        id: "abc1",
        score: 0.92,
        payload: { text: "Always check null before accessing .user" },
        collection: "experience-behavioral",
      },
      {
        id: "def2",
        score: 0.88,
        payload: { text: "Use try-catch around DB calls" },
        collection: "experience-behavioral",
      },
    ]);

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("[experience:");
    expect(result.enriched).toContain("Always check null before accessing .user");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
  });

  test("Test 2: returns ctx unchanged with applied=false and delta=no-points when searchByText throws", async () => {
    vi.mocked(searchByText).mockRejectedValue(new Error("network down"));

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toContain("error=");
  });

  test("Test 3: returns ctx unchanged with applied=false and delta=no-points when searchByText returns []", async () => {
    vi.mocked(searchByText).mockResolvedValue([]);

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toBe("no-points");
  });

  test("Test 4: extracts text from payload.json containing solution field", async () => {
    vi.mocked(searchByText).mockResolvedValue([
      {
        id: "xyz9",
        score: 0.75,
        payload: { json: JSON.stringify({ solution: "Always validate inputs at boundary" }) },
        collection: "experience-behavioral",
      },
    ]);

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("Always validate inputs at boundary");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
  });

  test("Test 5: hints are truncated via truncateToBudget at 30% of tokenBudget", async () => {
    const longText = "A".repeat(2000);
    vi.mocked(searchByText).mockResolvedValue([
      { id: "x", score: 0.9, payload: { text: longText }, collection: "experience-behavioral" },
    ]);

    const result = await layer3EeInjection(makeCtx({ tokenBudget: 100 }));
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        // Two parallel collections, each at 15% of budget: 15% of 100 tokens * 4 chars/token
        // = 60 chars per block + 3 for "..." suffix, joined with newline. Allow generous
        // ceiling for header text + 2 blocks, PLUS the dynamic pending-feedback reminder
        // (≤5 [id collection] lines) that replaced the fixed nudge. The 2000-char input
        // means a truncation regression would blow well past this bound regardless.
        expect(chars).toBeLessThanOrEqual(600);
      }
    }
  });

  test("Test 6: search hits server whitelist (behavioral + principles) regardless of taskType", async () => {
    vi.mocked(searchByText).mockResolvedValue([]);

    await layer3EeInjection(makeCtx({ taskType: "refactor" }));
    // New behavior: two parallel calls, one per collection (different score floors).
    expect(vi.mocked(searchByText)).toHaveBeenCalledWith(
      expect.any(String),
      ["experience-principles"],
      expect.any(Number),
      expect.any(Object),
    );
    expect(vi.mocked(searchByText)).toHaveBeenCalledWith(
      expect.any(String),
      ["experience-behavioral"],
      expect.any(Number),
      expect.any(Object),
    );
    // Phase 3 ee-anti-mu + upgrade: third call for compaction checkpoints (targeted query on behavioral collection).
    // Now lower score floor (0.7) + explicit PRESERVE/ee.query in contract/playbook + unconditional layer1 enrichment for sessionId turns.
    expect(vi.mocked(searchByText)).toHaveBeenCalledWith(
      expect.stringContaining("Context checkpoint summary"),
      ["experience-behavioral"],
      expect.any(Number),
      expect.any(Object),
    );
    expect(vi.mocked(searchByText)).toHaveBeenCalledTimes(3);
  });
});

describe("Layer 3 formatter mode (ctx._brainData populated)", () => {
  test("emits principles + experience blocks from ctx._brainData without brain call", async () => {
    const { layer3EeInjection } = await import("../layer3-ee-injection.js");
    const ctx = {
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
        t0_principles: [{ text: "always run tests", score: 0.9 }],
        t1_rules: ["never skip tests"],
        t2_patterns: [{ text: "mock fs in unit tests", score: 0.7 }],
        retrieval_skipped_reason: null,
      },
    };
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toContain("always run tests");
    expect(result.enriched).toContain("mock fs in unit tests");
    expect(result.t1Rules).toEqual(["never skip tests"]);
  });

  test("unified path: records rateable points (with id) into the ledger + names [id collection] in the reminder", async () => {
    // Symmetric with the legacy-path recall-loop closure. When the server (PIL
    // schema_version 1.1+) attributes points with id/collection, the unified
    // formatter must record them as pending debt and surface an actionable reminder.
    sessionRecallLedger.reset();
    const { layer3EeInjection } = await import("../layer3-ee-injection.js");
    const ctx = {
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
        t0_principles: [{ text: "always run tests", score: 0.9, id: "pr1", collection: "experience-principles" }],
        t1_rules: [],
        t2_patterns: [{ text: "mock fs in unit tests", score: 0.7, id: "be1", collection: "experience-behavioral" }],
        retrieval_skipped_reason: null,
      },
    };
    const result = await layer3EeInjection(ctx);
    // Inline [id:..] handle rendered so the reminder refers to something visible.
    expect(result.enriched).toContain("[id:pr1]");
    // Dynamic reminder names the actual [id collection] so ee_feedback is actionable.
    expect(result.enriched).toMatch(/ee_feedback\(id, collection, followed\|ignored\|noise\)/);
    expect(result.enriched).toContain("[pr1 experience-principles]");
    expect(result.enriched).toContain("[be1 experience-behavioral]");
    // Both points recorded as rateable pending debt.
    expect(sessionRecallLedger.pendingCount()).toBe(2);
  });

  test("back-pressure: at the ledger cap, passive injection stops growing debt but still injects content", async () => {
    // Regression for the unbounded-debt creep (muonroi.db: pendingCount 8→29 while
    // the nudge shows only ~10). Once passive debt hits PIL_PASSIVE_LEDGER_CAP (default
    // 15) a new injection must NOT record more rateable debt — otherwise the ledger can
    // never drain to zero — yet the hint content must still reach the prompt.
    sessionRecallLedger.reset();
    for (let i = 0; i < 15; i++) {
      sessionRecallLedger.record([{ id: `fill${i}`, collection: "experience-behavioral" }], "seed");
    }
    expect(sessionRecallLedger.pendingCount()).toBe(15);

    const { layer3EeInjection } = await import("../layer3-ee-injection.js");
    const result = await layer3EeInjection({
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
        t0_principles: [{ text: "always run tests", score: 0.9, id: "capA", collection: "experience-principles" }],
        t1_rules: [],
        t2_patterns: [{ text: "mock fs in unit tests", score: 0.7, id: "capB", collection: "experience-behavioral" }],
        retrieval_skipped_reason: null,
      },
    });
    // Debt stayed capped — the two new ids were NOT recorded.
    expect(sessionRecallLedger.pendingCount()).toBe(15);
    expect(sessionRecallLedger.isPending("capA")).toBe(false);
    // …but the content was still injected and its id is still visible for a manual rate.
    expect(result.enriched).toContain("always run tests");
    expect(result.enriched).toContain("[id:capA]");
  });

  test("unified path: no id (older server) renders text but stays unrateable (static nudge)", async () => {
    sessionRecallLedger.reset();
    const { layer3EeInjection } = await import("../layer3-ee-injection.js");
    const ctx = {
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
        t0_principles: [{ text: "always run tests", score: 0.9 }],
        t1_rules: [],
        t2_patterns: [{ text: "mock fs in unit tests", score: 0.7 }],
        retrieval_skipped_reason: null,
      },
    };
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toContain("always run tests");
    // No ids → nothing recorded; the static nudge is the fallback.
    expect(sessionRecallLedger.pendingCount()).toBe(0);
    expect(result.enriched).toContain(RECALL_FEEDBACK_NUDGE);
  });

  test("emits no block when ctx._brainData is null AND legacy disabled by flag", async () => {
    const { layer3EeInjection } = await import("../layer3-ee-injection.js");
    const ctx = {
      raw: "x",
      enriched: "x",
      taskType: "debug" as const,
      domain: null,
      confidence: 0.85,
      outputStyle: "balanced" as const,
      tokenBudget: 2000,
      metrics: null,
      layers: [],
      _brainData: null,
    };
    const result = await layer3EeInjection(ctx);
    expect(result.layers[0].name).toBe("ee-experience-injection");
  });
});
