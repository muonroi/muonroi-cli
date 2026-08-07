/**
 * Amendment A2 (task A2), table row "auto-council": the auto path passes
 * `skipClarification: true`, so without a fix `spec` stays at
 * `buildSpecFromTopic`'s degenerate default (`successCriteria = ["Address the
 * topic: <first 100 chars>"]`) — the S1 launch card would render boilerplate
 * as "what the council understood". `inferSpecFromTopicOnly` (clarifier.ts)
 * fixes this; these tests pin that it is actually called on the auto path
 * (and reaches the card), and that it is NOT called at all when no card will
 * ever render (`suppressPreDebateCards` / `sprintPlanningMode` — pure cost
 * otherwise).
 */
import { describe, expect, it, vi } from "vitest";

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
vi.mock("../../pil/pipeline.js", () => ({
  runPipeline: vi
    .fn()
    .mockResolvedValue({ taskType: "research", domain: "backend", outputStyle: "balanced", grayAreas: [] }),
}));
// Real pickCouncilTaskModel (returns leaderModelId unchanged when cost-aware
// is off — no catalog lookup needed) via importOriginal; only the network
// resolution calls are stubbed.
vi.mock("../leader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../leader.js")>();
  return {
    ...actual,
    resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
    resolveParticipants: vi.fn().mockResolvedValue([
      { role: "analyst", model: "mock-a", position: "" },
      { role: "critic", model: "mock-b", position: "" },
    ]),
  };
});
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
    isCouncilCostAware: vi.fn().mockReturnValue(false),
    getCouncilExperienceMode: vi.fn().mockReturnValue("advisory"),
    loadMcpServers: vi.fn().mockReturnValue([]),
    loadUserSettings: vi
      .fn()
      .mockReturnValue({ apiKey: undefined, defaultModel: "mock-model", providers: {}, roleModels: {} }),
  };
});
// Wrap the REAL inferSpecFromTopicOnly in a spy so we can both assert call
// counts AND let it actually run (driven by the crafted llm.generate below) —
// a fully-mocked replacement would prove nothing about what index.ts passes it.
vi.mock("../clarifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clarifier.js")>();
  return { ...actual, inferSpecFromTopicOnly: vi.fn(actual.inferSpecFromTopicOnly) };
});

// Stop right at the runDebate boundary — the card must already have rendered
// by then, and we don't need a realistic DebateState to prove it.
const RUN_DEBATE_STOP = new Error("STOP_AT_RUN_DEBATE_BOUNDARY");
vi.mock("../debate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debate.js")>();
  return {
    ...actual,
    // biome-ignore lint/correctness/useYield: throws before ever yielding — this IS the test boundary
    runDebate: vi.fn().mockImplementation(async function* () {
      throw RUN_DEBATE_STOP;
    }),
  };
});

const REAL_EXTRACTED_JSON = JSON.stringify({
  problemStatement: "Decide whether internal service-to-service calls should move to gRPC.",
  constraints: ["Must interoperate with the existing REST gateway"],
  successCriteria: [
    "p99 latency improves under load",
    "No breaking change for external API consumers",
    "Rollout is reversible per-service",
  ],
  scope: "In: internal mesh traffic. Out: public-facing endpoints.",
});
const SYNTHESIS_JSON = JSON.stringify({
  type: "evaluation",
  summary: "Council concluded with a clear recommendation grounded in docs/Council.md:42.",
  findings: ["docs/Council.md:42 shows the flow"],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

function buildMockLLM() {
  return {
    generate: vi.fn().mockImplementation(async (_modelId: string, system: string) => {
      // Matches clarifier.ts's inferSpecFromTopicOnly system prompt verbatim
      // opening line — every OTHER generate call (research-need, synthesis,
      // debate-plan retry) gets the generic SYNTHESIS_JSON instead.
      if (system.includes("extracting an implicit specification")) return REAL_EXTRACTED_JSON;
      return SYNTHESIS_JSON;
    }),
    research: vi.fn().mockResolvedValue("## Source Code Findings\n- [docs/Council.md:42] flow"),
    debate: vi.fn().mockResolvedValue({ text: "Position [CONFIRMED via docs/Council.md:42]", toolCalls: [] }),
  };
}

async function driveToStop(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<{ chunks: any[] }> {
  const chunks: any[] = [];
  try {
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
  } catch (err) {
    if (err !== RUN_DEBATE_STOP) throw err;
  }
  return { chunks };
}

const isLaunchCard = (c: any) =>
  c?.type === "council_question" && String(c?.councilQuestion?.questionId).startsWith("council-setup-");

async function runAutoCouncil(sessionId: string, options: Record<string, unknown>) {
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi.fn().mockResolvedValue("start");
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  const { chunks } = await driveToStop(
    runCouncil(
      "should we switch internal calls to grpc",
      "mock-model",
      [],
      sessionId,
      buildMockLLM(),
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      { skipClarification: true, ...options },
    ),
  );
  return { chunks };
}

describe("auto-council spec inference (Amendment A2)", () => {
  it("reaches the S1 card with a spec from inferSpecFromTopicOnly, never the boilerplate default", async () => {
    const clarifierMod = await import("../clarifier.js");
    const spy = clarifierMod.inferSpecFromTopicOnly as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { chunks } = await runAutoCouncil("sess-auto-infer", {});

    expect(spy).toHaveBeenCalledTimes(1);
    const launchCards = chunks.filter(isLaunchCard);
    expect(launchCards).toHaveLength(1);
    const card = launchCards[0];
    // Positive: the REAL extracted problem statement/outcome reached the card.
    expect(card.councilQuestion.question).toBe("Decide whether internal service-to-service calls should move to gRPC.");
    expect(card.councilQuestion.context).toContain("p99 latency improves under load");
    // Negative: never the degenerate buildSpecFromTopic fallback.
    expect(card.councilQuestion.context).not.toContain("Address the topic:");
  });

  it("suppressPreDebateCards shows NO card and makes NO inference call", async () => {
    const clarifierMod = await import("../clarifier.js");
    const spy = clarifierMod.inferSpecFromTopicOnly as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { chunks } = await runAutoCouncil("sess-auto-suppressed", {
      suppressPreDebateCards: true,
      suppressPostDebate: true,
    });

    expect(chunks.some(isLaunchCard)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sprintPlanningMode shows NO card and makes NO inference call", async () => {
    const clarifierMod = await import("../clarifier.js");
    const spy = clarifierMod.inferSpecFromTopicOnly as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { chunks } = await runAutoCouncil("sess-auto-sprint", { sprintPlanningMode: true });

    expect(chunks.some(isLaunchCard)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
