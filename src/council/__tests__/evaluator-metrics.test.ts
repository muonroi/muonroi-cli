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

  it("countUnverified matches [UNVERIFIED:...] tags", () => {
    const text = "Some claim [UNVERIFIED: no source for this RTT number] and another [UNVERIFIED].";
    const matches = text.match(/\[UNVERIFIED[^\]]*\]/g);
    expect(matches?.length).toBe(2);
  });

  it("evidenceDensity = cited / (cited + unverified) — flag-aware metric", () => {
    // Mirror computeEvidenceDensity from debate.ts.
    // Old metric was cited / total-sentences which couldn't exceed ~0.05 in
    // any real debate (most sentences aren't citable claims). New metric only
    // counts claims that participants explicitly flagged.
    const text =
      "Verified fact [CONFIRMED via web_fetch: x]. Verified again [CONFIRMED via grep:found]. " +
      "Unsure number [UNVERIFIED: typical RTT]. Another unsure [UNVERIFIED: corpus coverage]. " +
      "Lots of opinion prose that should not affect the density.";
    const cited = (text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g) ?? []).length;
    const unverified = (text.match(/\[UNVERIFIED[^\]]*\]/g) ?? []).length;
    const totalTagged = cited + unverified;
    const density = totalTagged > 0 ? cited / totalTagged : 0;
    expect(cited).toBe(2);
    expect(unverified).toBe(2);
    expect(density).toBe(0.5);
  });

  it("evidenceDensity is 0 when no claims were tagged at all", () => {
    const text = "This is pure opinion. No tags. No evidence awareness shown.";
    const cited = (text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g) ?? []).length;
    const unverified = (text.match(/\[UNVERIFIED[^\]]*\]/g) ?? []).length;
    const totalTagged = cited + unverified;
    const density = totalTagged > 0 ? cited / totalTagged : 0;
    expect(density).toBe(0);
  });

  it("evidenceDensity is 1.0 when every tagged claim was verified", () => {
    const text = "[CONFIRMED via bash:test]. [CONFIRMED via grep:found]. [REFUTED via web:no-match].";
    const cited = (text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g) ?? []).length;
    const unverified = (text.match(/\[UNVERIFIED[^\]]*\]/g) ?? []).length;
    const totalTagged = cited + unverified;
    const density = totalTagged > 0 ? cited / totalTagged : 0;
    expect(density).toBe(1.0);
  });
});

// ── P3: Lock-phrase convergence detection ────────────────────────────────────

describe("P3: convergence ratio over a round's pair-turns", () => {
  // Mirror LOCK_PHRASES and convergenceRatio from debate.ts — kept in sync
  // by code review. If the production list grows, this test should mirror
  // the addition so behaviour stays observable.
  const LOCK_PHRASES = [
    /\bever[yi]thing\s+(is\s+)?locked\b/i,
    /\bfully\s+aligned\b/i,
    /\bcomplete\s+agreement\b/i,
    /\bno\s+remaining\s+(disputes|disagreements|concerns)\b/i,
    /\bdesign\s+(is\s+)?locked\b/i,
    /\barchitectural\s+decisions\s+(are\s+)?locked\b/i,
    /\bagree\s+on\s+where\s+we['']?ve\s+landed\b/i,
    /\bready\s+to\s+(proceed|move|start)\s+to\s+implementation\b/i,
    /\blet['']?s\s+proceed\s+to\s+implementation\b/i,
    /\bfinal\s+(position|confirmation)\b/i,
  ];
  function looksLocked(text: string): boolean {
    if (!text || text.length < 20) return false;
    return LOCK_PHRASES.some((re) => re.test(text));
  }
  function convergenceRatio(turns: string[]): number {
    const usable = turns.filter((t) => t && t.trim().length >= 20);
    if (usable.length === 0) return 0;
    const locked = usable.filter(looksLocked).length;
    return locked / usable.length;
  }

  it("session ea13da132dec round 3 turns trip the 0.8 lock threshold", () => {
    // Excerpts taken verbatim from the export; each is one pair-turn.
    const r3Turns = [
      "I agree with your comprehensive summary. Everything else is locked. I'm satisfied with where we've landed.",
      "We're fully aligned. Everything Locked. No remaining disputes. The pipeline spec is now: ...",
      "We're aligned. Two quick confirmations from my side: ... Design locked. The implementation spec can proceed.",
      "We are in complete agreement on every architectural decision. The implementation specification can proceed.",
      "All architectural decisions are locked. The only outstanding UX tweak is the short selectionchange dismissal delay.",
      "All architectural decisions are locked. I'm ready to start drafting the content-script and background-script.",
    ];
    const ratio = convergenceRatio(r3Turns);
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("returns 0 when no turn contains lock phrases", () => {
    const turns = [
      "I still disagree about the debounce timing. 200ms feels sluggish for single-word selections.",
      "Your argument for batch translation has merit but breaks the offline-first guarantee.",
    ];
    expect(convergenceRatio(turns)).toBe(0);
  });

  it("ignores empty / too-short turns when computing ratio", () => {
    const turns = ["", "ok", "All architectural decisions are locked, no remaining disputes."];
    expect(convergenceRatio(turns)).toBe(1.0);
  });

  it("partial convergence (1 of 3 turns locked) is below threshold", () => {
    const turns = [
      "Design is locked from my side, ready to proceed.",
      "I still have concerns about rate-limit handling under high load.",
      "The auth flow needs another pass — we haven't settled on token rotation.",
    ];
    expect(convergenceRatio(turns)).toBeLessThan(0.8);
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
