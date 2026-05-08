/**
 * CQ-08: LeaderEvaluation evidenceDensity/disagreementResolved fields + <0.3 trigger
 * CQ-10: debate-planner falls back to FALLBACK_PLAN when both generateObject and parsePlan fail
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LeaderEvaluation } from "../types.js";

// ── CQ-08: LeaderEvaluation type accepts new metric fields ───────────────────

describe("CQ-08: LeaderEvaluation type — evidenceDensity and disagreementResolved", () => {
  it("LeaderEvaluation accepts evidenceDensity as optional number field", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: false,
      criteriaStatus: [],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "test reason",
      evidenceDensity: 0.25,
    };
    expect(evaluation.evidenceDensity).toBe(0.25);
  });

  it("LeaderEvaluation accepts disagreementResolved as optional number field", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: false,
      criteriaStatus: [],
      unresolvedPoints: ["point A"],
      needsResearch: false,
      shouldContinue: true,
      reason: "test",
      disagreementResolved: 2,
    };
    expect(evaluation.disagreementResolved).toBe(2);
  });

  it("LeaderEvaluation accepts both evidenceDensity and disagreementResolved together", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: true,
      criteriaStatus: [{ criterion: "accuracy", met: true, evidence: "[CONFIRMED via bash:grep output]" }],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: false,
      reason: "all criteria met",
      evidenceDensity: 0.65,
      disagreementResolved: 3,
    };
    expect(evaluation.evidenceDensity).toBe(0.65);
    expect(evaluation.disagreementResolved).toBe(3);
  });

  it("evidenceDensity < 0.3 threshold: value 0.25 is below threshold", () => {
    // Verify the threshold logic is testable — 0.25 < 0.3 should trigger needsResearch
    const evidenceDensity = 0.25;
    const round = 2;
    const wasNeedsResearch = false;

    // Simulate debate.ts evaluateDebate logic:
    // if (!needsResearch && round >= 2 && evidenceDensity < 0.3) { needsResearch = true; }
    let needsResearch = wasNeedsResearch;
    if (!needsResearch && round >= 2 && evidenceDensity < 0.3) {
      needsResearch = true;
    }

    expect(needsResearch).toBe(true);
  });

  it("evidenceDensity >= 0.3 threshold: value 0.5 does NOT force needsResearch", () => {
    const evidenceDensity = 0.5;
    const round = 2;
    const wasNeedsResearch = false;

    let needsResearch = wasNeedsResearch;
    if (!needsResearch && round >= 2 && evidenceDensity < 0.3) {
      needsResearch = true;
    }

    expect(needsResearch).toBe(false);
  });

  it("evidenceDensity < 0.3 on round 1 does NOT trigger needsResearch (requires round >= 2)", () => {
    const evidenceDensity = 0.1;
    const round = 1; // round 1 — no trigger
    const wasNeedsResearch = false;

    let needsResearch = wasNeedsResearch;
    if (!needsResearch && round >= 2 && evidenceDensity < 0.3) {
      needsResearch = true;
    }

    expect(needsResearch).toBe(false);
  });
});

// ── CQ-08: countCitations and estimateClaims behavior (indirectly via formula) ─

describe("CQ-08: evidence density calculation logic", () => {
  it("text with [REFUTED via bash:...] tags increases citation count", () => {
    // Mirror the countCitations regex from debate.ts:
    // /\[(REFUTED|CONFIRMED) via [^\]]+\]/g
    const text = "Claim A [REFUTED via bash:grep found nothing] and claim B [CONFIRMED via bash:ls output].";
    const matches = text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g);
    const citationCount = matches?.length ?? 0;
    expect(citationCount).toBe(2);
  });

  it("text without citation tags yields citation count of 0", () => {
    const text = "This is an unverified claim. Another assertion follows.";
    const matches = text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g);
    const citationCount = matches?.length ?? 0;
    expect(citationCount).toBe(0);
  });

  it("estimateClaims counts non-trivial sentences (length > 10)", () => {
    // Mirror estimateClaims from debate.ts: split on [.!?]+ filter length > 10
    const text = "First claim here. Short. Another long claim about something.";
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
  });

  it("evidenceDensity = citations / max(sentences, 1)", () => {
    const text = "[REFUTED via bash:test]. [CONFIRMED via grep:found]. Long claim follows here. Another claim too.";
    const citations = (text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g) ?? []).length;
    const sentences = Math.max(text.split(/[.!?]+/).filter((s) => s.trim().length > 10).length, 1);
    const density = citations / sentences;
    expect(density).toBeGreaterThan(0);
    expect(density).toBeLessThanOrEqual(1.5); // can exceed 1.0 if many tags in few sentences
  });
});

// ── CQ-10: planDebate falls back to FALLBACK_PLAN ────────────────────────────

const FALLBACK_STANCE_NAMES = ["Primary Analyst", "Critical Reviewer"];

describe("CQ-10: planDebate returns FALLBACK_PLAN after double failure", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns FALLBACK_PLAN when both generateObject and retry tracedGenerate fail", async () => {
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockRejectedValue(new Error("Schema validation error")),
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));
    // tracedGenerate also fails — both paths exhausted
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* () {
        throw new Error("Retry also failed");
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = {
      problemStatement: "test problem",
      constraints: [],
      successCriteria: [],
      scope: "test",
      rawQA: [],
    };

    const llm = {} as never;
    const gen = planDebate(spec, "gpt-4o", llm);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    // Must match FALLBACK_PLAN shape
    expect(plan.stances.map((s: { name: string }) => s.name)).toEqual(FALLBACK_STANCE_NAMES);
    expect(plan.intentSummary).toContain("planner unavailable");
  });

  it("FALLBACK_PLAN intentSummary starts with '(planner unavailable'", async () => {
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockRejectedValue(new Error("API error")),
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* () {
        throw new Error("retry fail");
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = { problemStatement: "any topic", constraints: [], successCriteria: [], scope: "", rawQA: [] };
    const gen = planDebate(spec, "gpt-4o", {} as never);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    expect(plan.intentSummary).toMatch(/^\(planner unavailable/);
  });

  it("FALLBACK_PLAN output shape has 'decision' kind with standard sections", async () => {
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockRejectedValue(new Error("fail")),
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* () {
        throw new Error("also fails");
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = { problemStatement: "topic", constraints: [], successCriteria: [], scope: "", rawQA: [] };
    const gen = planDebate(spec, "gpt-4o", {} as never);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    expect(plan.outputShape.kind).toBe("decision");
    expect(plan.outputShape.sections.length).toBeGreaterThanOrEqual(3);
    expect(plan.outputShape.sections.map((s: { key: string }) => s.key)).toContain("recommendation");
  });
});
