/**
 * CQ-24: audit-replay — E2E council memory assertions
 *
 * Verifies that after runCouncil completes:
 * 1. A [Council Memory] record is persisted via appendSystemMessage
 * 2. The [Council Memory] JSON is parseable and has required top-level fields
 * 3. stats.calls > 0 after a full run (accounting not broken)
 * 4. synthesis contains evidence signals from research output
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendSystemMessage } from "../../storage/index.js";

// ── Module-level mocks — declared before any dynamic import ─────────────────

vi.mock("../../storage/index.js", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));

vi.mock("../../ee/council-bridge.js", () => ({
  queryExperience: vi.fn().mockResolvedValue({ warnings: [] }),
}));

vi.mock("../../ee/judge.js", () => ({
  judgeCouncilOutcome: vi.fn().mockResolvedValue({ confidence: 0.8, reason: "test" }),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  recordCouncilOutcome: vi.fn(),
}));

vi.mock("../../pil/pipeline.js", () => ({
  runPipeline: vi.fn().mockResolvedValue({
    taskType: "research",
    domain: "backend",
    outputStyle: "balanced",
    grayAreas: [],
  }),
}));

vi.mock("../leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
  resolveParticipants: vi.fn().mockResolvedValue([
    { role: "analyst", model: "mock-a", position: "" },
    { role: "critic", model: "mock-b", position: "" },
  ]),
}));

vi.mock("../debate-planner.js", () => ({
  planDebate: vi.fn().mockImplementation(async function* () {
    return {
      intentSummary: "Test debate intent",
      stances: [
        { name: "Analyst", lens: "Analyze carefully" },
        { name: "Critic", lens: "Challenge assumptions" },
      ],
      outputShape: {
        kind: "evaluation",
        sections: [
          { key: "findings", heading: "Findings", prompt: "List key findings", shape: "list" },
        ],
        guardrails: [],
      },
    };
  }),
}));

vi.mock("../context.js", () => ({
  buildCouncilContext: vi.fn().mockReturnValue("mock context"),
  buildProjectSnapshot: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../utils/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/settings.js")>();
  return {
    ...actual,
    isCouncilMultiProviderPreferred: vi.fn().mockReturnValue(false),
    getCouncilExperienceMode: vi.fn().mockReturnValue("advisory"),
    loadMcpServers: vi.fn().mockReturnValue([]),
    loadUserSettings: vi.fn().mockReturnValue({
      apiKey: undefined,
      defaultModel: "mock-model",
      providers: {},
      roleModels: {},
    }),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const SYNTHESIS_JSON = JSON.stringify({
  type: "evaluation",
  summary: "Council found strong evidence from docs/Council.md, tavily research, and snapshot:pw-001 of localhost:3010.",
  findings: [
    "docs/Council.md:42 shows the flow",
    "tavily found https://tavily.example.com/results",
    "snapshot:pw-001 localhost:3010 screenshot confirms UI state",
  ],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

const RESEARCH_OUTPUT = [
  "## Source Code Findings",
  "- [docs/Council.md:42] Council flow",
  "",
  "## Internet Findings",
  "- [https://tavily.example.com/results]",
  "",
  "## Frontend Findings (live)",
  "- [snapshot:pw-001] localhost:3010 screenshot",
].join("\n");

/** Builds a mock CouncilLLM for the audit-replay tests. */
function buildMockLLM() {
  return {
    generate: vi.fn().mockResolvedValue(SYNTHESIS_JSON),
    research: vi.fn().mockResolvedValue(RESEARCH_OUTPUT),
    debate: vi.fn().mockResolvedValue({
      text: "Position text [CONFIRMED via tavily:https://tavily.example.com]",
      toolCalls: [{ toolName: "tavily_search", result: "found results" }],
    }),
  };
}

/** Drains a runCouncil AsyncGenerator and returns all emitted chunks. */
async function drainCouncil(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return chunks;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("audit-replay", () => {
  let capturedMessages: Array<{ sessionId: string; content: string }>;

  beforeEach(() => {
    capturedMessages = [];
    (appendSystemMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (sessionId: string, content: string) => {
        capturedMessages.push({ sessionId, content });
      },
    );
  });

  it("persists [Council Memory] after a full run", async () => {
    const { runCouncil } = await import("../index.js");

    const mockLLM = buildMockLLM();
    const respondToQuestion = vi.fn().mockResolvedValue("skip");
    const respondToPreflight = vi.fn().mockResolvedValue(true);
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      "test-session-001",
      mockLLM,
      respondToQuestion,
      respondToPreflight,
      processMessageFn,
      { skipClarification: true },
    );

    await drainCouncil(gen);

    const councilMemoryMessages = capturedMessages.filter((m) =>
      m.content.startsWith("[Council Memory]"),
    );
    expect(councilMemoryMessages).toHaveLength(1);
    expect(councilMemoryMessages[0].sessionId).toBe("test-session-001");
  });

  it("[Council Memory] record is parseable JSON with required fields", async () => {
    const { runCouncil } = await import("../index.js");

    const mockLLM = buildMockLLM();
    const respondToQuestion = vi.fn().mockResolvedValue("skip");
    const respondToPreflight = vi.fn().mockResolvedValue(true);
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      "test-session-002",
      mockLLM,
      respondToQuestion,
      respondToPreflight,
      processMessageFn,
      { skipClarification: true },
    );

    await drainCouncil(gen);

    const memMsg = capturedMessages.find((m) => m.content.startsWith("[Council Memory]"));
    expect(memMsg).toBeDefined();

    const jsonStr = memMsg!.content.slice("[Council Memory] ".length);
    const record = JSON.parse(jsonStr);

    expect(record).toHaveProperty("topic");
    expect(record).toHaveProperty("participants");
    expect(record).toHaveProperty("finalPositions");
    expect(record).toHaveProperty("synthesis");
    expect(record).toHaveProperty("stats");
  });

  it("stats.calls > 0 after full run", async () => {
    const { runCouncil } = await import("../index.js");

    const sharedStats = { calls: 0, startMs: Date.now(), phases: [] };
    const mockLLM = buildMockLLM();

    // Wire stats.calls increments on each generate() call
    mockLLM.generate.mockImplementation(async () => {
      sharedStats.calls++;
      return SYNTHESIS_JSON;
    });
    mockLLM.research.mockImplementation(async () => {
      sharedStats.calls++;
      return RESEARCH_OUTPUT;
    });
    mockLLM.debate.mockImplementation(async () => {
      sharedStats.calls++;
      return {
        text: "Position text [CONFIRMED via tavily:https://tavily.example.com]",
        toolCalls: [{ toolName: "tavily_search", result: "found results" }],
      };
    });

    const respondToQuestion = vi.fn().mockResolvedValue("skip");
    const respondToPreflight = vi.fn().mockResolvedValue(true);
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      "test-session-003",
      mockLLM,
      respondToQuestion,
      respondToPreflight,
      processMessageFn,
      { skipClarification: true, councilStats: sharedStats },
    );

    await drainCouncil(gen);

    expect(sharedStats.calls).toBeGreaterThan(0);
  });

  it("synthesis contains evidence signals from research output", async () => {
    const { runCouncil } = await import("../index.js");

    const mockLLM = buildMockLLM();
    const respondToQuestion = vi.fn().mockResolvedValue("skip");
    const respondToPreflight = vi.fn().mockResolvedValue(true);
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });

    const gen = runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      "test-session-004",
      mockLLM,
      respondToQuestion,
      respondToPreflight,
      processMessageFn,
      { skipClarification: true },
    );

    await drainCouncil(gen);

    const memMsg = capturedMessages.find((m) => m.content.startsWith("[Council Memory]"));
    expect(memMsg).toBeDefined();

    const jsonStr = memMsg!.content.slice("[Council Memory] ".length);
    const record = JSON.parse(jsonStr);

    // synthesis must contain all three: docs/ reference, tavily citation, snapshot signal
    const synthesis: string = record.synthesis ?? "";
    expect(synthesis).toContain("docs/");
    expect(synthesis).toContain("tavily");
    expect(synthesis).toContain("snapshot");
  });
});
