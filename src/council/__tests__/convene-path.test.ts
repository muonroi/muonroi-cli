/**
 * convenePath — the `convene_council` builtin runs the full debate+synthesis but
 * MUST NOT emit any post-debate decision surface (no card, no recommendation, no
 * onPostDebateAction, no continuation). The agent that called the tool decides
 * what happens next; the CLI hardcodes nothing (user directive).
 *
 * Guards both directions: convenePath:true suppresses the post-debate card and
 * returns the synthesis; convenePath:false still shows it (no over-suppression).
 */
import { describe, expect, it, vi } from "vitest";
import { buildNeutralPostCouncilContinuation, postDebateContinuation } from "../index.js";

vi.mock("../../storage/index", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));
vi.mock("../../ee/council-bridge.js", () => ({ queryExperience: vi.fn().mockResolvedValue({ warnings: [] }) }));
// runCouncil now wires per-stance recall (getDefaultEEClient) into runDebate.
// Stub the client so the debate opening never hits the network or writes surfaces
// to the real brain during unit tests. Recall → null → openings stay unseeded.
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
vi.mock("../leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
  resolveParticipants: vi.fn().mockResolvedValue([
    { role: "analyst", model: "mock-a", position: "" },
    { role: "critic", model: "mock-b", position: "" },
  ]),
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
    getCouncilExperienceMode: vi.fn().mockReturnValue("advisory"),
    loadMcpServers: vi.fn().mockReturnValue([]),
    loadUserSettings: vi
      .fn()
      .mockReturnValue({ apiKey: undefined, defaultModel: "mock-model", providers: {}, roleModels: {} }),
  };
});

const SYNTHESIS_JSON = JSON.stringify({
  type: "evaluation",
  summary: "Council concluded with a clear recommendation grounded in docs/Council.md:42.",
  findings: ["docs/Council.md:42 shows the flow"],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

function buildMockLLM() {
  return {
    generate: vi.fn().mockResolvedValue(SYNTHESIS_JSON),
    research: vi.fn().mockResolvedValue("## Source Code Findings\n- [docs/Council.md:42] flow"),
    debate: vi.fn().mockResolvedValue({ text: "Position [CONFIRMED via docs/Council.md:42]", toolCalls: [] }),
  };
}

async function runToEnd(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<{ chunks: any[]; ret: unknown }> {
  const chunks: any[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { chunks, ret: step.value };
}

const isPostDebateCard = (c: any) => c?.type === "council_question" && c?.councilQuestion?.phase === "post-debate";

describe("convenePath post-debate suppression", () => {
  it("convenePath:true emits NO post-debate card, never calls respondToQuestion, returns the synthesis", async () => {
    const { runCouncil } = await import("../index.js");
    const respondToQuestion = vi.fn().mockResolvedValue("save_exit");
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });
    const { chunks, ret } = await runToEnd(
      runCouncil(
        "Should we use gRPC internally?",
        "mock-model",
        [],
        "sess-convene-1",
        buildMockLLM(),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, convenePath: true },
      ),
    );
    expect(chunks.some(isPostDebateCard)).toBe(false);
    expect(respondToQuestion).not.toHaveBeenCalled();
    expect(typeof ret).toBe("string");
    expect(ret as string).toContain("clear recommendation");
  });

  it("convenePath:false (default) DOES emit the post-debate card (no over-suppression)", async () => {
    const { runCouncil } = await import("../index.js");
    const respondToQuestion = vi.fn().mockResolvedValue("save_exit");
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });
    const { chunks } = await runToEnd(
      runCouncil(
        "Should we use gRPC internally?",
        "mock-model",
        [],
        "sess-convene-2",
        buildMockLLM(),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true },
      ),
    );
    expect(chunks.some(isPostDebateCard)).toBe(true);
    expect(respondToQuestion).toHaveBeenCalled();
  });
});

describe("/council convenePath continuation source", () => {
  const SYNTH = '```json\n{"type":"analysis","conclusion":"x"}\n```';
  it("neutral builder returns a prompt where postDebateContinuation(undefined) returns null", () => {
    // Card suppressed → chosenAction undefined → the OLD path stopped (null).
    expect(postDebateContinuation(undefined, SYNTH)).toBeNull();
    // New path always hands the synthesis to the agent.
    expect(buildNeutralPostCouncilContinuation(SYNTH)).toContain(SYNTH);
  });
});
