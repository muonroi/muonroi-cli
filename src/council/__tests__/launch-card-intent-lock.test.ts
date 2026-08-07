/**
 * The launch card (S1) now leads with an intent question (design 2026-08-04,
 * council/index.ts:820-881). Picking an intent option yields a one-line
 * "Intent locked: …" confirmation chunk into the transcript; picking a
 * run-shape option (start/cheap/refine/cancel) must NOT emit that chunk —
 * those are shape picks, not intent picks. This file pins that transcript
 * contract, which is otherwise unasserted by any other test (code review
 * finding on task-2, 2026-08-06).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const contentText = (chunks: any[]) =>
  chunks
    .filter((c: any) => c?.type === "content")
    .map((c: any) => c.content ?? "")
    .join("");

/**
 * Drives runCouncil with a `respondToQuestion` that answers the council-setup
 * card with `setupAnswer` and every other question (post-debate, escalation,
 * etc.) with the neutral terminal action "save_exit" — mirrors the pattern in
 * post-debate-answer-routing.test.ts, but keyed per-questionId so the setup
 * answer can differ from the post-debate answer.
 */
async function runWithSetupAnswer(setupAnswer: string, sessionId: string) {
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi
    .fn()
    .mockImplementation(async (questionId: string) =>
      questionId.startsWith("council-setup-") ? setupAnswer : "save_exit",
    );
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  const { chunks } = await runToEnd(
    runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      sessionId,
      buildMockLLM(),
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      { skipClarification: true },
    ),
  );
  return { chunks };
}

const INTENT_LOCKED_PREFIX = "Intent locked:";

/**
 * Task 10 + C2 — the S1 launch card must be reachable from the `/council` slash
 * path, AND the lock it takes must reach its consumers.
 *
 * Task 10 fixed only the first half with `allowLaunchCard`, which showed the
 * card while `convenePath` still skipped the whole post-debate block — the only
 * place `spec.intentKind` is ever read (`resolveRunKind`, and the
 * planner/plan-review/post-plan-card path). So the gate was cosmetic: the user
 * picked "Implement — plan it, review it, then build", paid for the debate, and
 * got the neutral continuation.
 *
 * C2 replaced the combined flag with `suppressPreDebateCards` (no human to
 * answer a blocking card) and `suppressPostDebate` (the CLI must not hardcode
 * the next step). `/council` now sets NEITHER — the same shape auto-council
 * uses — and the agent-convened callers set BOTH.
 */
async function runWithGateOptions(options: Record<string, unknown>, sessionId: string) {
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi
    .fn()
    .mockImplementation(async (questionId: string) =>
      questionId.startsWith("council-setup-") ? "start" : "save_exit",
    );
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  const { chunks } = await runToEnd(
    runCouncil(
      "Should we use gRPC internally?",
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
  return { chunks, respondToQuestion };
}

const isSetupCard = (c: any) => c?.type === "council_question" && c?.councilQuestion?.phase === "council-setup";
const isPostDebateCard = (c: any) => c?.type === "council_question" && c?.councilQuestion?.phase === "post-debate";

describe("launch card reachable via /council (task 10 + C2)", () => {
  // The B4 mid-debate escalation card deliberately REUSES phase "post-debate"
  // (debate.ts:~2708), so `isPostDebateCard` cannot tell the two apart. It is
  // also auto-accepted under `suppressPreDebateCards`, which would make the
  // suppression assertions below depend on which flag happened to silence it.
  // Turn it off so "a post-debate card appeared" means the real one.
  let prevEscalate: string | undefined;
  beforeEach(() => {
    prevEscalate = process.env.MUONROI_COUNCIL_ESCALATE;
    process.env.MUONROI_COUNCIL_ESCALATE = "0";
  });
  afterEach(() => {
    if (prevEscalate === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
    else process.env.MUONROI_COUNCIL_ESCALATE = prevEscalate;
  });

  it("slash-path shape (no suppressions) emits the council-setup card", async () => {
    const { chunks } = await runWithGateOptions({}, "sess-slash-reach");
    expect(chunks.some(isSetupCard)).toBe(true);
  });

  it("agent-convened shape (suppressPreDebateCards) emits NO council-setup card", async () => {
    const { chunks } = await runWithGateOptions(
      { suppressPreDebateCards: true, suppressPostDebate: true },
      "sess-agent-convened",
    );
    expect(chunks.some(isSetupCard)).toBe(false);
  });

  it("C2 — the slash-path shape now REACHES the post-debate block, so the lock has a consumer", async () => {
    // The regression this pins: with the old combined flag the slash path
    // emitted the setup card and then suppressed the post-debate block, which
    // holds the ONLY two readers of spec.intentKind. The card was decoration.
    const { chunks } = await runWithGateOptions({}, "sess-slash-postdebate");
    expect(chunks.some(isSetupCard)).toBe(true);
    expect(chunks.some(isPostDebateCard)).toBe(true);
  });

  it("the two suppressions are independent — post-debate can be suppressed while S1 still shows", async () => {
    const { chunks } = await runWithGateOptions({ suppressPostDebate: true }, "sess-split-flags");
    expect(chunks.some(isSetupCard)).toBe(true);
    expect(chunks.some(isPostDebateCard)).toBe(false);
  });
});

describe("launch card intent-lock transcript chunk", () => {
  it("picking an intent option emits the Intent locked confirmation", async () => {
    // "action_items" is a real IntentKind, distinct from the mocked
    // debatePlan.outputShape.kind ("evaluation") that the card recommends —
    // this is a deliberate pick, not the pre-selected default.
    const { chunks } = await runWithSetupAnswer("action_items", "sess-intent-pick");
    const text = contentText(chunks);
    expect(text).toContain(INTENT_LOCKED_PREFIX);
    expect(text).toContain("Produce action items");
  });

  it.each(["start", "cheap"])("picking the shape option %s does NOT emit Intent locked", async (choice) => {
    const { chunks } = await runWithSetupAnswer(choice, `sess-shape-${choice}`);
    expect(contentText(chunks)).not.toContain(INTENT_LOCKED_PREFIX);
  });

  it.each(["refine", "cancel"])("picking %s does NOT emit Intent locked", async (choice) => {
    const { chunks } = await runWithSetupAnswer(choice, `sess-terminal-${choice}`);
    expect(contentText(chunks)).not.toContain(INTENT_LOCKED_PREFIX);
  });
});
