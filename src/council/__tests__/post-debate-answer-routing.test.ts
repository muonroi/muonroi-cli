/**
 * Post-debate answer routing — the two ways the pinned "Keep working the N unmet
 * criteria" option used to dead-end.
 *
 * Live evidence (session 811336618ee0, 2026-07-31): the card was answered at
 * 07:06:01 with `answerKind:"freetext", answerText:""` against
 * `selectedOptionLabel:"Keep working the 2 unmet criteria"`. The empty string
 * matched no branch in the post-debate switch, so the council fell through to
 * the save_exit tail, marked the sub-session `completed` 13ms later and
 * discarded the only instruction the user gave it. The `ask_followup` VALUE was
 * equally dead: `isFollowupText` was true for it, but the follow-up branch was
 * guarded `&& answer !== "ask_followup"`.
 */
import { describe, expect, it, vi } from "vitest";
import { COUNCIL_ANSWER_DISMISSED } from "../types.js";

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

const FOLLOWUP_MARKER = "Council answering follow-up using prior debate context";

async function runWithAnswer(answer: string, sessionId: string) {
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi.fn().mockResolvedValue(answer);
  const onPostDebateAction = vi.fn();
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  const llm = buildMockLLM();
  const { chunks } = await runToEnd(
    runCouncil(
      "Should we use gRPC internally?",
      "mock-model",
      [],
      sessionId,
      llm,
      respondToQuestion,
      vi.fn().mockResolvedValue(true),
      processMessageFn,
      { skipClarification: true, onPostDebateAction },
    ),
  );
  // The B4 escalation card deliberately REUSES phase "post-debate" (debate.ts:
  // "same askcard renderer, no new UI"), so it can appear first in the stream.
  // The continuation card is always the LAST one.
  const cards = chunks.filter(isPostDebateCard);
  const card = cards[cards.length - 1];
  return { chunks, card, cards, llm, onPostDebateAction, respondToQuestion };
}

const contentText = (chunks: any[]) =>
  chunks
    .filter((c) => c?.type === "content")
    .map((c) => c.content ?? "")
    .join("");

describe("post-debate empty answer resolves to the recommended default", () => {
  it("an empty submit takes the pre-selected option instead of silently exiting", async () => {
    const { card, onPostDebateAction } = await runWithAnswer("", "sess-empty-answer");
    expect(card).toBeTruthy();
    const defaultValue = card.councilQuestion.options[card.councilQuestion.defaultIndex]?.value;
    expect(defaultValue).toBeTruthy();
    // The regression: this used to be "" — the action the user picked was lost.
    expect(onPostDebateAction).toHaveBeenCalledWith(defaultValue);
  });

  it("a real choice is passed through untouched", async () => {
    const { onPostDebateAction } = await runWithAnswer("save_exit", "sess-explicit-answer");
    expect(onPostDebateAction).toHaveBeenCalledWith("save_exit");
  });

  it("an Esc DISMISS stays a no-op and never takes the default", async () => {
    // The TUI cancel path also used to send "" (use-app-logic.tsx), so honouring
    // the default for an empty answer would have turned Esc into "run the
    // recommended action" — a worse bug than the one being fixed. The dismiss
    // sentinel keeps the two apart.
    const { chunks, onPostDebateAction } = await runWithAnswer(COUNCIL_ANSWER_DISMISSED, "sess-dismissed");
    expect(onPostDebateAction).toHaveBeenCalledWith("");
    expect(contentText(chunks)).not.toContain(FOLLOWUP_MARKER);
  });
});

describe("post-debate ask_followup actually runs a follow-up", () => {
  it("routes the pinned follow-up option into a re-synthesis pass", async () => {
    const { chunks, llm } = await runWithAnswer("ask_followup", "sess-ask-followup");
    // Previously: no branch matched, so this marker never appeared and the run
    // went straight to persistence.
    expect(contentText(chunks)).toContain(FOLLOWUP_MARKER);
    expect(llm.generate.mock.calls.length).toBeGreaterThan(1);
  });

  it("save_exit still does NOT trigger a follow-up pass", async () => {
    const { chunks } = await runWithAnswer("save_exit", "sess-no-followup");
    expect(contentText(chunks)).not.toContain(FOLLOWUP_MARKER);
  });
});
