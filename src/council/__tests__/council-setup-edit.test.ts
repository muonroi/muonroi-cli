/**
 * Amendment A2 (task A2) — the S1 launch card's "Edit topic or outcome" round.
 *
 * Pins three things end-to-end through `runCouncil`:
 *  - Trap 1 (`runCouncil` passes BOTH `spec` and `topic` to `runDebate`): an
 *    edit must rewrite BOTH, or the raw topic silently diverges from the
 *    corrected spec. Asserted at the `runDebate` call boundary via a mocked
 *    `../debate.js`, not just on the `spec` object — a mutation that only
 *    wrote `spec.problemStatement` would still fail this test.
 *  - Trap 2 (`parseIntentAnswer` coerces any string matching a valid
 *    `IntentKind` into that kind): a freetext edit whose text happens to equal
 *    an IntentKind value ("evaluation") must be applied as topic text, not
 *    silently reinterpreted as an intent pick.
 *  - The edit round does not start the run (card re-renders) and the round
 *    cap terminates a pathological "always edit" sequence.
 */
import { describe, expect, it, vi } from "vitest";
import { EDIT_SPEC_OPTION_VALUE } from "../launch-card.js";
import type { ClarifiedSpec } from "../types.js";

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
vi.mock("../leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
  resolveParticipants: vi.fn().mockResolvedValue([
    { role: "analyst", model: "mock-a", position: "" },
    { role: "critic", model: "mock-b", position: "" },
  ]),
}));
// Proposed kind is deliberately "decision" — NOT "evaluation" — so the Trap 2
// test can prove the freetext string "evaluation" never reaches
// parseIntentAnswer: if it did, spec.intentKind would end up "evaluation"
// instead of correctly falling back to the proposed "decision".
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
        kind: "decision",
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

// The Trap-1 boundary: capture exactly what runDebate was called with, then
// stop the run — we don't need a realistic DebateState to pin this contract,
// only the (spec, config) arguments runDebate actually received.
const RUN_DEBATE_CALLS: Array<{ spec: ClarifiedSpec; topic: string }> = [];
const RUN_DEBATE_STOP = new Error("STOP_AT_RUN_DEBATE_BOUNDARY");
vi.mock("../debate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debate.js")>();
  return {
    ...actual,
    // biome-ignore lint/correctness/useYield: throws before ever yielding — this IS the test boundary
    runDebate: vi.fn().mockImplementation(async function* (spec: ClarifiedSpec, config: { topic: string }) {
      RUN_DEBATE_CALLS.push({ spec: { ...spec }, topic: config.topic });
      throw RUN_DEBATE_STOP;
    }),
  };
});

const SYNTHESIS_JSON = JSON.stringify({
  type: "decision",
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
const isEditTopicQ = (c: any) =>
  c?.type === "council_question" && String(c?.councilQuestion?.questionId).startsWith("council-edit-topic-");
const isEditOutcomeQ = (c: any) =>
  c?.type === "council_question" && String(c?.councilQuestion?.questionId).startsWith("council-edit-outcome-");

async function runScenario(sessionId: string, answers: Record<string, string>) {
  RUN_DEBATE_CALLS.length = 0;
  const { runCouncil } = await import("../index.js");
  const respondToQuestion = vi.fn().mockImplementation(async (questionId: string) => {
    if (Object.hasOwn(answers, questionId)) return answers[questionId];
    return "save_exit"; // any question this scenario didn't script (post-debate etc.)
  });
  const processMessageFn = vi.fn().mockImplementation(async function* () {
    yield { type: "done" };
  });
  const { chunks } = await driveToStop(
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

describe("S1 edit round — Trap 1 (spec + topic must move together)", () => {
  it("an edit rewrites BOTH spec.problemStatement and the topic handed to runDebate", async () => {
    const sessionId = "sess-edit-trap1";
    const { chunks } = await runScenario(sessionId, {
      [`council-setup-${sessionId}-0`]: EDIT_SPEC_OPTION_VALUE,
      [`council-edit-topic-${sessionId}-1`]: "Corrected topic: pick gRPC for internal service mesh",
      [`council-edit-outcome-${sessionId}-1`]: "p99 latency under 50ms\nNo breaking API change",
      [`council-setup-${sessionId}-1`]: "start",
    });

    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    const call = RUN_DEBATE_CALLS[0];
    // This is the assertion that pins Trap 1: both fields must carry the SAME
    // edited value. A production bug that only writes spec.problemStatement
    // (or only reassigns topic) fails exactly one of the next two lines.
    expect(call.spec.problemStatement).toBe("Corrected topic: pick gRPC for internal service mesh");
    expect(call.topic).toBe("Corrected topic: pick gRPC for internal service mesh");
    expect(call.spec.successCriteria).toEqual(["p99 latency under 50ms", "No breaking API change"]);

    // The card must have re-rendered (round 0 AND round 1), not started on the edit.
    const launchCards = chunks.filter(isLaunchCard);
    expect(launchCards.length).toBeGreaterThanOrEqual(2);
  });

  it("an edit does not start the run — no runDebate call happens until a non-edit choice is made", async () => {
    const sessionId = "sess-edit-no-start";
    const { chunks } = await runScenario(sessionId, {
      [`council-setup-${sessionId}-0`]: EDIT_SPEC_OPTION_VALUE,
      [`council-edit-topic-${sessionId}-1`]: "",
      [`council-edit-outcome-${sessionId}-1`]: "",
      [`council-setup-${sessionId}-1`]: "start",
    });
    // Exactly one runDebate call — the one AFTER the edit round, never one
    // triggered by the edit pick itself.
    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    expect(chunks.some(isEditTopicQ)).toBe(true);
    expect(chunks.some(isEditOutcomeQ)).toBe(true);
  });

  it("blank edit answers keep the current topic/outcome unchanged", async () => {
    const sessionId = "sess-edit-blank";
    await runScenario(sessionId, {
      [`council-setup-${sessionId}-0`]: EDIT_SPEC_OPTION_VALUE,
      [`council-edit-topic-${sessionId}-1`]: "",
      [`council-edit-outcome-${sessionId}-1`]: "",
      [`council-setup-${sessionId}-1`]: "start",
    });
    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    expect(RUN_DEBATE_CALLS[0].topic).toBe("Should we use gRPC internally?");
  });
});

describe("S1 edit round — Trap 2 (freetext must never be read as an intent pick)", () => {
  it("freetext that looks like a valid IntentKind value is applied as topic text, not coerced into an intent pick", async () => {
    const sessionId = "sess-trap2-collision";
    const { chunks } = await runScenario(sessionId, {
      [`council-setup-${sessionId}-0`]: EDIT_SPEC_OPTION_VALUE,
      // "evaluation" is a REAL IntentKind value. Typed here (via the dedicated
      // freetext edit question, never through the launch card's own answer),
      // it must land as literal topic text.
      [`council-edit-topic-${sessionId}-1`]: "evaluation",
      [`council-edit-outcome-${sessionId}-1`]: "",
      // "start" is not a valid IntentKind either, so parseIntentAnswer falls
      // back to the leader's proposed kind — "decision" per the mocked
      // debate plan above, NEVER "evaluation".
      [`council-setup-${sessionId}-1`]: "start",
    });

    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    const call = RUN_DEBATE_CALLS[0];
    expect(call.topic).toBe("evaluation");
    expect(call.spec.problemStatement).toBe("evaluation");
    // The load-bearing negative: intentKind must be the debate plan's
    // proposed kind, NOT hijacked into "evaluation" by the coincidental text.
    expect(call.spec.intentKind).toBe("decision");
    // No "Intent locked" chunk was emitted from the SETUP-CARD answer at
    // round 1 either — "start" is a shape pick, not an intent pick.
    const introText = chunks
      .filter((c: any) => c?.type === "content")
      .map((c: any) => c.content ?? "")
      .join("");
    expect(introText).not.toContain("Intent locked: Evaluate");
  });

  it("a valid intent pick on the launch card is still parsed as an intent pick (no edit sub-round fires)", async () => {
    const sessionId = "sess-trap2-valid-pick";
    const { chunks } = await runScenario(sessionId, {
      // "action_items" is a real IntentKind, distinct from the mocked
      // proposed kind ("decision") — a deliberate pick, not the default.
      [`council-setup-${sessionId}-0`]: "action_items",
    });
    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    expect(RUN_DEBATE_CALLS[0].spec.intentKind).toBe("action_items");
    expect(RUN_DEBATE_CALLS[0].topic).toBe("Should we use gRPC internally?"); // unedited
    expect(chunks.some(isEditTopicQ)).toBe(false);
    expect(chunks.some(isEditOutcomeQ)).toBe(false);
    const introText = chunks
      .filter((c: any) => c?.type === "content")
      .map((c: any) => c.content ?? "")
      .join("");
    expect(introText).toContain("Intent locked:");
  });
});

describe("S1 edit round — the edit-round cap terminates", () => {
  it("repeatedly picking Edit stops after MAX_LAUNCH_CARD_EDIT_ROUNDS and the run still proceeds", async () => {
    const { MAX_LAUNCH_CARD_EDIT_ROUNDS } = await import("../index.js");
    const sessionId = "sess-edit-cap";
    const answers: Record<string, string> = {};
    for (let round = 0; round <= MAX_LAUNCH_CARD_EDIT_ROUNDS; round++) {
      answers[`council-setup-${sessionId}-${round}`] = EDIT_SPEC_OPTION_VALUE;
      answers[`council-edit-topic-${sessionId}-${round + 1}`] = `edit round ${round + 1}`;
      answers[`council-edit-outcome-${sessionId}-${round + 1}`] = "";
    }
    const { chunks } = await runScenario(sessionId, answers);

    // The loop must terminate — proven by runDebate eventually being reached
    // at all (a hang would leave RUN_DEBATE_CALLS empty and the test would
    // time out instead of failing cleanly, but this assertion is the
    // deterministic check once it does terminate).
    expect(RUN_DEBATE_CALLS).toHaveLength(1);
    // At most MAX_LAUNCH_CARD_EDIT_ROUNDS edit round-trips could have fired
    // (rounds 0..MAX inclusive render a card = MAX+1 renders), never more.
    const launchCards = chunks.filter(isLaunchCard);
    expect(launchCards.length).toBeLessThanOrEqual(MAX_LAUNCH_CARD_EDIT_ROUNDS + 1);
    // The final rendered card must have stopped OFFERING the edit option.
    const lastCard = launchCards[launchCards.length - 1];
    const lastOptionValues = lastCard.councilQuestion.options.map((o: any) => o.value);
    expect(lastOptionValues).not.toContain(EDIT_SPEC_OPTION_VALUE);
  });

  // Code-review finding (MINOR, task A2 review): the loop's break condition
  // (`choice !== EDIT_SPEC_OPTION_VALUE || editRounds >= MAX_LAUNCH_CARD_EDIT_ROUNDS`)
  // can exit with `choice` still equal to the sentinel — reachable only if a
  // caller returns a value the rendered card never actually offered (the cap
  // already dropped the edit option via `allowEdit: false`). Downstream,
  // `parseIntentAnswer`'s unknown-value fallback happens to absorb that case
  // TODAY, which is exactly why relying on it is fragile: nothing pins the
  // sentinel-at-the-run-shape-handling case if that parser's fallback rule
  // ever changes. `resolveCappedChoice` is the explicit guard extracted so
  // this is testable on its own, independent of `parseIntentAnswer`.
  it("resolveCappedChoice clamps the sentinel to 'start' and leaves every other value untouched", async () => {
    const { resolveCappedChoice } = await import("../index.js");
    // This is the exact scenario the cap can leave behind: the loop exits via
    // the cap disjunct while `choice` still holds the sentinel.
    expect(resolveCappedChoice(EDIT_SPEC_OPTION_VALUE)).toBe("start");
    // Every real run-shape/intent/terminal value must pass through unchanged
    // — this guard must not perturb any value it wasn't built for.
    for (const untouched of ["start", "cheap", "refine", "cancel", "action_items", "evaluation", ""]) {
      expect(resolveCappedChoice(untouched)).toBe(untouched);
    }
  });
});
