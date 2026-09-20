/**
 * sprint-planning-mode-escalation.test.ts — D6.
 *
 * `RunCouncilOptions.sprintPlanningMode` is the "no human is present" signal
 * for `/ideal`'s sprint-internal councils (sprint-planning in
 * sprint-runner.ts, the per-item debate in item-debate-runner.ts). Every
 * other askcard-gating site in council/index.ts already ORs this flag with
 * `suppressPreDebateCards` (see `willShowLaunchCard`, the preflight
 * `autoApprove` derivation, the whole post-debate branch tree) — but the one
 * feeding `CouncilConfig.autoAcceptEscalation` into `runDebate` didn't.
 *
 * Both sprintPlanningMode callers use `skipClarification: true`, so BOTH get
 * the same single degenerate pinned criterion from `buildSpecFromTopic`
 * (clarifier.ts) — `"Address the topic: <topic>"` — never zero criteria.
 * Sprint planning's debate argues that topic directly each round and
 * typically satisfies it by round 1-2. What actually let the ITEM debate
 * reach the stop-with-unmet boundary is `perRoundFocus` (C2): it scopes each
 * round to argue one selected plan item instead of the whole topic, so the
 * leader's per-round evaluation of that same criterion can stay unmet for the
 * debate's entire round budget. That gap let a sprintPlanningMode debate open
 * the mid-debate B4 escalation askcard and block an unattended `/ideal` run —
 * live evidence: run mu75rurpf9ec / session f52d9bfc50a2, blocked 2026-09-18
 * 19:15 UTC to 2026-09-20 09:07 UTC (38 hours) on "The debate reached its
 * progress limit with 1 criterion still unmet."
 *
 * This pins the wiring itself: `sprintPlanningMode: true` (with NO
 * `suppressPreDebateCards`) must reach `runDebate` with
 * `autoAcceptEscalation: true`. `leader-conductor.test.ts`'s
 * "D6: autoAcceptEscalation resolves..." test covers the other half — what
 * `runDebate` actually does with that flag once set.
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

// Stop right at the runDebate boundary, capturing the exact config it was
// called with — that config is what this test exists to inspect.
const RUN_DEBATE_STOP = new Error("STOP_AT_RUN_DEBATE_BOUNDARY");
const runDebateMock = vi.fn().mockImplementation(
  // biome-ignore lint/correctness/useYield: throws before ever yielding — this IS the test boundary
  async function* () {
    throw RUN_DEBATE_STOP;
  },
);
vi.mock("../debate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debate.js")>();
  return { ...actual, runDebate: runDebateMock };
});

const SYNTHESIS_JSON = JSON.stringify({
  type: "evaluation",
  summary: "Council concluded with a clear recommendation.",
  findings: [],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

function buildMockLLM() {
  return {
    generate: vi.fn().mockResolvedValue(SYNTHESIS_JSON),
    research: vi.fn().mockResolvedValue(""),
    debate: vi.fn().mockResolvedValue({ text: "A debate contribution.", toolCalls: [] }),
  };
}

async function driveToStop(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<void> {
  try {
    let step = await gen.next();
    while (!step.done) step = await gen.next();
  } catch (err) {
    if (err !== RUN_DEBATE_STOP) throw err;
  }
}

async function runToDebateBoundary(sessionId: string, options: Record<string, unknown>) {
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi.fn().mockResolvedValue("start");
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  await driveToStop(
    runCouncil(
      "argue the plan item",
      "mock-model",
      [],
      sessionId,
      buildMockLLM(),
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      // Same shape item-debate-runner.ts / sprint-runner.ts's sprint-planning
      // call site actually use.
      { skipClarification: true, autoApprovePreflight: true, skipResearch: true, ...options },
    ),
  );
}

describe("D6: sprintPlanningMode wiring into CouncilConfig.autoAcceptEscalation", () => {
  it("sprintPlanningMode alone (no suppressPreDebateCards) reaches runDebate with autoAcceptEscalation: true", async () => {
    runDebateMock.mockClear();

    await runToDebateBoundary("sess-sprint-escalation", { sprintPlanningMode: true });

    expect(runDebateMock).toHaveBeenCalledTimes(1);
    const config = runDebateMock.mock.calls[0]?.[1] as { autoAcceptEscalation?: boolean } | undefined;
    expect(config?.autoAcceptEscalation).toBe(true);
  });

  it("suppressPreDebateCards alone still reaches runDebate with autoAcceptEscalation: true (unchanged)", async () => {
    runDebateMock.mockClear();

    await runToDebateBoundary("sess-agent-convened-escalation", { suppressPreDebateCards: true });

    expect(runDebateMock).toHaveBeenCalledTimes(1);
    const config = runDebateMock.mock.calls[0]?.[1] as { autoAcceptEscalation?: boolean } | undefined;
    expect(config?.autoAcceptEscalation).toBe(true);
  });

  it("neither flag set (interactive /council) does NOT auto-accept escalation", async () => {
    runDebateMock.mockClear();

    await runToDebateBoundary("sess-interactive-escalation", {});

    expect(runDebateMock).toHaveBeenCalledTimes(1);
    const config = runDebateMock.mock.calls[0]?.[1] as { autoAcceptEscalation?: boolean } | undefined;
    expect(config?.autoAcceptEscalation).toBeFalsy();
  });
});
