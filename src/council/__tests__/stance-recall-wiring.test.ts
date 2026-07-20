/**
 * stance-recall-wiring — proves runCouncil actually wires per-stance recall INTO
 * the debate opening, not merely that a function crossed a config boundary.
 *
 * Guards three things a shape-only assertion would miss:
 *  1. The wired recall fires once per UNIQUE participant role, tagged with that
 *     role as `stance` (so the server can weight collections per stance).
 *  2. The recalled seed SURVIVES into an opening prompt — i.e. it reaches
 *     `llm.generate` under the "## Experience recall — … lens" header. This is
 *     the end-to-end path (index.ts → runDebate prefetch → debate.ts:760-773).
 *  3. `experienceMode: "off"` suppresses the wiring entirely — no recall fires.
 */
import { describe, expect, it, vi } from "vitest";
import { logInteraction } from "../../storage/index";

// Hoisted so the vi.mock factory below can close over the same spy we assert on.
const { recallSpy } = vi.hoisted(() => ({ recallSpy: vi.fn() }));

vi.mock("../../storage/index", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));
vi.mock("../../ee/council-bridge.js", () => ({ queryExperience: vi.fn().mockResolvedValue({ warnings: [] }) }));
vi.mock("../../ee/intercept.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ee/intercept.js")>();
  return { ...actual, getDefaultEEClient: () => ({ recall: recallSpy }) };
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
  summary: "Council concluded with a clear recommendation.",
  findings: ["a finding"],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

function buildMockLLM() {
  return {
    generate: vi.fn().mockResolvedValue(SYNTHESIS_JSON),
    research: vi.fn().mockResolvedValue("## Source Code Findings\n- [docs/x.md:1] finding"),
    debate: vi.fn().mockResolvedValue({ text: "Position [CONFIRMED]", toolCalls: [] }),
  };
}

async function drain(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<void> {
  let step = await gen.next();
  while (!step.done) step = await gen.next();
}

const SEED = "SEED-MARKER-XYZ";

async function runOnce() {
  const { runCouncil } = await import("../index.js");
  const llm = buildMockLLM();
  await drain(
    runCouncil(
      "Should we adopt per-stance recall?",
      "mock-model",
      [],
      "sess-stance-wiring",
      llm,
      vi.fn().mockResolvedValue("save_exit"),
      vi.fn().mockResolvedValue(true),
      vi.fn().mockImplementation(async function* () {
        yield { type: "done" };
      }),
      { skipClarification: true, convenePath: true },
    ),
  );
  return llm;
}

describe("runCouncil per-stance recall wiring", () => {
  it("fires one stance-tagged recall per unique role and folds the seed into an opening prompt", async () => {
    recallSpy.mockReset();
    recallSpy.mockResolvedValue({ text: SEED });
    vi.mocked(logInteraction).mockClear();

    const llm = await runOnce();

    // 1. One recall per unique participant role, each tagged with its role as stance.
    const stances = recallSpy.mock.calls.map((c) => (c[1] as { stance?: string } | undefined)?.stance).sort();
    expect(stances).toEqual(["analyst", "critic"]);

    // 2. The seed reached an opening prompt under the experience-recall header.
    const sawSeededOpening = llm.generate.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(SEED) && arg.includes("Experience recall")),
    );
    expect(sawSeededOpening).toBe(true);

    // 3. A stance_recall telemetry event records which roles actually got a seed.
    const stanceLog = vi.mocked(logInteraction).mock.calls.find((c) => c[2]?.eventSubtype === "stance_recall");
    expect(stanceLog).toBeDefined();
    expect((stanceLog?.[2]?.data as { seededRoles?: string[] })?.seededRoles?.sort()).toEqual(["analyst", "critic"]);
  });

  it("fires NO recall when experienceMode is off", async () => {
    recallSpy.mockReset();
    recallSpy.mockResolvedValue({ text: SEED });
    const settings = await import("../../utils/settings.js");
    vi.mocked(settings.getCouncilExperienceMode).mockReturnValue("off");
    try {
      await runOnce();
      expect(recallSpy).not.toHaveBeenCalled();
    } finally {
      vi.mocked(settings.getCouncilExperienceMode).mockReturnValue("advisory");
    }
  });
});
