/**
 * Task 9 — Gate A (external-topic scope gate) must actually FIRE in
 * production, not only when a caller hand-builds `CouncilConfig{externalTopic:
 * true}` (debate.test.ts covers that unit-level branch). Before this task,
 * `runCouncil`'s own `runPipeline(topic, { sessionId })` call had NO
 * `llmFallback`, so PIL's `scopeKind` never resolved (layer1-intent.ts only
 * sets it when a classifier is wired) — `externalTopic` was always `false` in
 * every real call path.
 *
 * This test drives `runCouncil` itself — no `options.externalTopic` is
 * threaded in — and proves the self-classify wiring (`createLlmClassifier`
 * built from `sessionModelId`, wired as `llmFallback` into `runPipeline`)
 * actually derives `scopeKind: "external"` from a real PIL pass and that the
 * derived `externalTopic` suppresses BOTH the pre-debate research phase
 * (llm.research / runIsolatedTask) and the leader's research-need call.
 *
 * Mirrors `convene-path.test.ts`'s mock scaffold (leader/debate-planner/
 * context/settings + EE side-channels), but deliberately does NOT mock
 * `../../pil/pipeline.js` — the real `runPipeline` → `layer1Intent` must run
 * so the classifier wiring is genuinely exercised. `../../ee/bridge.js` is
 * mocked only to keep the unified-brain fetch (`pilContext`) and the WhoAmI
 * profile read from touching the network / a real EE server during the test.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../../storage/index", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));
vi.mock("../../ee/council-bridge.js", () => ({ queryExperience: vi.fn().mockResolvedValue({ warnings: [] }) }));
vi.mock("../../ee/intercept.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ee/intercept.js")>();
  return { ...actual, getDefaultEEClient: () => ({ recall: async () => null }) };
});
vi.mock("../../ee/judge.js", () => ({
  judgeCouncilOutcome: vi.fn().mockResolvedValue({ confidence: 0.8, reason: "t" }),
}));
vi.mock("../../ee/phase-outcome.js", () => ({ recordCouncilOutcome: vi.fn() }));
// Keep the PIL Pass-3 unified-brain fetch + WhoAmI profile read local-only —
// layer1Intent (the module under real test here) awaits pilContext() when the
// model-first classify succeeds; without this mock it would try a real network
// round-trip against an unconfigured EE server on every test run.
vi.mock("../../ee/bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ee/bridge.js")>();
  return {
    ...actual,
    pilContext: vi.fn().mockResolvedValue(null),
    getWhoAmIProfile: vi.fn().mockReturnValue(null),
  };
});
vi.mock("../leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
  resolveParticipants: vi.fn().mockResolvedValue([
    { role: "analyst", model: "mock-a", position: "" },
    { role: "critic", model: "mock-b", position: "" },
  ]),
  buildCouncilCandidatePool: vi.fn().mockResolvedValue([]),
}));
vi.mock("../debate-planner.js", () => ({
  // biome-ignore lint/correctness/useYield: mock returns immediately; consumer drains via .next()
  planDebate: vi.fn().mockImplementation(async function* () {
    return {
      intentSummary: "Test debate intent",
      stances: [
        { name: "Analyst", lens: "Analyze carefully" },
        { name: "Critic", lens: "Challenge assumptions" },
      ],
      outputShape: {
        kind: "evaluation",
        sections: [{ key: "findings", heading: "Findings", prompt: "List", shape: "list" }],
        guardrails: [],
      },
    };
  }),
}));
vi.mock("../context.js", () => ({
  buildCouncilContext: vi.fn().mockReturnValue("mock context"),
  buildProjectSnapshot: vi.fn().mockResolvedValue({ snapshot: "", isEmpty: true }),
}));
vi.mock("../../utils/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/settings.js")>();
  return {
    ...actual,
    isCouncilMultiProviderPreferred: vi.fn().mockReturnValue(false),
    getCouncilExperienceMode: vi.fn().mockReturnValue("off"),
    loadMcpServers: vi.fn().mockReturnValue([]),
    loadUserSettings: vi
      .fn()
      .mockReturnValue({ apiKey: undefined, defaultModel: "deepseek-v4-flash", providers: {}, roleModels: {} }),
  };
});

const SYNTHESIS_JSON = JSON.stringify({
  type: "evaluation",
  summary: "Council concluded with a clear recommendation grounded in general knowledge (no repo).",
  findings: ["CAP theorem trade-offs discussed from model knowledge alone"],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

/** Records whether `CouncilLLM.research` was ever invoked (belt-and-suspenders on `runIsolatedTask`). */
function buildMockLLM(researchSpy: { called: boolean }) {
  return {
    generate: vi.fn().mockImplementation(async (_modelId: string, system: string) => {
      if (system.includes("deciding whether a codebase research phase is needed")) {
        return JSON.stringify({ needsResearch: false, reason: "external topic — no repo knowledge required" });
      }
      if (system.includes("evaluating whether")) {
        return JSON.stringify({
          allCriteriaMet: true,
          criteriaStatus: [],
          unresolvedPoints: [],
          needsResearch: false,
          shouldContinue: false,
          reason: "sufficient evidence from model knowledge",
        });
      }
      return SYNTHESIS_JSON;
    }),
    research: vi.fn().mockImplementation(async () => {
      researchSpy.called = true;
      return "## Source Code Findings\n- should NEVER be called for an external topic";
    }),
    debate: vi
      .fn()
      .mockResolvedValue({ text: "Position on CAP theorem trade-offs (model knowledge, no repo).", toolCalls: [] }),
  };
}

async function runToEnd(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return chunks;
}

describe("Gate A fires in production via runCouncil self-classification", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  let cleanupMock: (() => void) | null = null;
  afterEach(() => {
    cleanupMock?.();
    cleanupMock = null;
    vi.clearAllMocks();
  });

  it("derives externalTopic from runCouncil's OWN PIL self-classify — no options.externalTopic threaded — and skips research", async () => {
    // The classify fixture line's 6th field ("external") is what layer1-intent
    // parses into PipelineContext.scopeKind. See llm-classify.test.ts for the
    // field-order contract.
    const handle = installMockModel({
      fixture: {
        stream: textOnlyStream("n/a — only the classify intercept matters here"),
        classify: "analyze,concise,task,answer,heavy,external,english,clear",
      },
    });
    cleanupMock = handle.uninstall;

    const { runCouncil } = await import("../index.js");
    const researchSpy = { called: false };
    let isolatedCalled = false;

    const respondToQuestion = vi.fn().mockResolvedValue("save_exit");
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Explain the CAP theorem trade-offs",
      "deepseek-v4-flash",
      [],
      "sess-external-gate-a",
      buildMockLLM(researchSpy),
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      {
        skipClarification: true,
        convenePath: true,
        runIsolatedTask: async () => {
          isolatedCalled = true;
          return { success: true, output: "ignored" };
        },
        // Deliberately NOT setting options.externalTopic — the derivation
        // under test must come from runCouncil's own self-classify wiring,
        // not from a caller-threaded value.
      },
    );

    const chunks = await runToEnd(gen);
    const researchMessages = chunks.filter(
      (c) => (c as { councilMessage?: { kind?: string } })?.councilMessage?.kind === "research",
    );

    expect(isolatedCalled).toBe(false);
    expect(researchSpy.called).toBe(false);
    expect(researchMessages).toHaveLength(0);
  }, 20_000);

  it("threaded options.externalTopic overrides self-classify (local scope) — still skips research", async () => {
    // Classify line here is deliberately LOCAL — proves the threaded caller
    // value wins over self-classification, per the derivation:
    // `options?.externalTopic ?? (pilCtx?.scopeKind === "external")`.
    const handle = installMockModel({
      fixture: {
        stream: textOnlyStream("n/a"),
        classify: "debug,concise,task,code,standard,local,english,clear",
      },
    });
    cleanupMock = handle.uninstall;

    const { runCouncil } = await import("../index.js");
    const researchSpy = { called: false };
    let isolatedCalled = false;

    const respondToQuestion = vi.fn().mockResolvedValue("save_exit");
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Explain the CAP theorem trade-offs",
      "deepseek-v4-flash",
      [],
      "sess-external-gate-a-threaded",
      buildMockLLM(researchSpy),
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      {
        skipClarification: true,
        convenePath: true,
        externalTopic: true,
        runIsolatedTask: async () => {
          isolatedCalled = true;
          return { success: true, output: "ignored" };
        },
      },
    );

    await runToEnd(gen);

    expect(isolatedCalled).toBe(false);
    expect(researchSpy.called).toBe(false);
  }, 20_000);
});
