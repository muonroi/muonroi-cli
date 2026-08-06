/**
 * C1 — the runCouncil → tool-engine SEAM.
 *
 * `plan-execution-wiring.test.ts` drains `runCouncil` directly and asserts on
 * the `processMessageFn` it was handed, so it can only ever see the N phase
 * turns. It is structurally blind to what the CALLER does after the generator
 * returns — and that is exactly where the defect lived: `runCouncil` fired
 * `onPostDebateAction("implement")` at index.ts:1713, BEFORE the plan block at
 * :1948-2084 ran, and never re-fired. tool-engine.ts:852-886 then read
 * `lastPostDebateAction === "implement"`, built the ~14K-char
 * `postDebateContinuation("implement", …)` prose ("Implement this now… carry it
 * out through your normal workflow") and ran it through `deps.processMessage` —
 * a SECOND, ungated implementation turn on the raw synthesis, on top of the
 * gated per-phase loop that had just run.
 *
 * It fired identically when the phase loop HALTED on a failed verify (voiding
 * the halt guarantee one statement later), when the user picked `save_exit`,
 * and when they pressed Esc.
 *
 * This file reproduces the seam: drain `runCouncil` capturing
 * `onPostDebateAction`, then run tool-engine's own continuation block against
 * the captured action and count total `processMessage` invocations. N phases
 * must produce exactly N calls, never N+1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { COUNCIL_ANSWER_DISMISSED } from "../types.js";

vi.mock("../../storage/index", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));

/**
 * I8 — an ordered log of "a phase turn ran" vs "the session was marked
 * completed". Hoisted so the SessionStore mock factory (which vitest lifts above
 * every import) can push into the same array the assertions read.
 */
const { timeline } = vi.hoisted(() => ({ timeline: [] as string[] }));
vi.mock("../../storage/sessions.js", () => ({
  SessionStore: class {
    constructor(_cwd: string) {}
    setStatus(_id: string, status: string) {
      timeline.push(`session:${status}`);
    }
  },
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
    { role: "analyst", model: "mock-a", position: "final position A" },
    { role: "critic", model: "mock-b", position: "final position B" },
  ]),
  pickCouncilTaskModel: vi.fn((_task: string, leaderModelId: string) => leaderModelId),
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
        kind: "implementation_plan",
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
  type: "implementation_plan",
  summary: "Council concluded: add the sentinel.",
  findings: ["docs/Council.md:42 shows the flow"],
  plan: { steps: [], estimatedComplexity: "trivial", prerequisites: [] },
});

/** Two phases, so "N calls, not N+1" has a number bigger than one to be wrong about. */
function plannerJson(p0Verify: string, p1Verify: string): string {
  return [
    "```json",
    JSON.stringify({
      phases: [
        {
          id: "P0",
          title: "Sentinel",
          steps: ["Add the spy"],
          files: ["src/council/index.ts"],
          acceptance: ["Sentinel wins end to end"],
          verify: p0Verify,
        },
        {
          id: "P1",
          title: "Wire it",
          steps: ["Wire the spy"],
          files: ["src/council/plan-execution.ts"],
          acceptance: ["Wiring holds"],
          verify: p1Verify,
        },
      ],
    }),
    "```",
  ].join("\n");
}

const APPROVE_VERDICT = ["```council-verdict", JSON.stringify({ verdict: "approve", concerns: [] }), "```"].join("\n");

function buildMockLLM(plannerPayload: string) {
  return {
    generate: vi.fn().mockImplementation(async (_modelId: string, _system: string, prompt: string) => {
      if (prompt.includes("You are the council PLANNER")) return plannerPayload;
      if (prompt.includes("--- PLAN.md ---")) return APPROVE_VERDICT;
      return SYNTHESIS_JSON;
    }),
    research: vi.fn().mockResolvedValue("## Source Code Findings\n- [docs/Council.md:42] flow"),
    debate: vi.fn().mockResolvedValue({ text: "Position [CONFIRMED via docs/Council.md:42]", toolCalls: [] }),
  };
}

function buildAnswerer(planCardAnswer: string): {
  chunks: StreamChunk[];
  respondToQuestion: (id: string) => Promise<string>;
} {
  const chunks: StreamChunk[] = [];
  const respondToQuestion = vi.fn(async (_id: string) => {
    const last = chunks[chunks.length - 1];
    const values = (last?.councilQuestion?.options ?? []).map((o) => o.value);
    if (values.includes("execute_plan") || values.includes("revise_plan")) return planCardAnswer;
    if (values.includes("implement")) return "implement";
    if (values.includes("escalate_accept")) return "escalate_accept";
    return "save_exit";
  });
  return { chunks, respondToQuestion: respondToQuestion as unknown as (id: string) => Promise<string> };
}

/**
 * tool-engine.ts:851-886 verbatim in shape: read the relayed action + locked
 * intent kind off the CouncilManager equivalents, ask `postDebateContinuation`
 * for a re-entry prompt, and if it returns one, run it through processMessage.
 * This is the code path that produced the extra ungated turn.
 */
async function runToolEngineSeam(args: {
  synthesis: string | null;
  chosenAction: string | null;
  lockedIntentKind: string | null;
  processMessage: (m: string) => AsyncGenerator<StreamChunk, void, unknown>;
}): Promise<string | null> {
  const { postDebateContinuation } = await import("../index.js");
  const prompt = args.synthesis
    ? postDebateContinuation(
        args.chosenAction ?? undefined,
        args.synthesis,
        (args.lockedIntentKind ?? undefined) as never,
      )
    : null;
  if (prompt) {
    for await (const _ of args.processMessage(prompt)) {
      /* drain */
    }
  }
  return prompt;
}

async function drain(gen: AsyncGenerator<StreamChunk, unknown, unknown>, chunks: StreamChunk[]): Promise<unknown> {
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return step.value;
}

describe("C1 — no ungated implement turn after the gated phase loop", () => {
  let cwd: string;
  let prevEscalate: string | undefined;

  beforeEach(() => {
    prevEscalate = process.env.MUONROI_COUNCIL_ESCALATE;
    process.env.MUONROI_COUNCIL_ESCALATE = "0";
    cwd = mkdtempSync(join(tmpdir(), "council-seam-"));
    timeline.length = 0;
  });

  afterEach(() => {
    if (prevEscalate === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
    else process.env.MUONROI_COUNCIL_ESCALATE = prevEscalate;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runSeam(opts: {
    planCardAnswer: string;
    p0Verify: string;
    p1Verify: string;
  }): Promise<{ calls: string[]; relayedAction: string | null; continuation: string | null }> {
    const { runCouncil } = await import("../index.js");
    const calls: string[] = [];
    const processMessageFn = vi.fn().mockImplementation(async function* (message: string) {
      calls.push(message);
      timeline.push(`phase:${calls.length}`);
      yield { type: "done" };
    });
    const { chunks, respondToQuestion } = buildAnswerer(opts.planCardAnswer);

    let relayedAction: string | null = null;
    let lockedIntentKind: string | null = null;

    const synthesis = (await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-seam",
        buildMockLLM(plannerJson(opts.p0Verify, opts.p1Verify)),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        {
          skipClarification: true,
          cwd,
          onPostDebateAction: (a: string) => {
            relayedAction = a;
          },
          onIntentLocked: (k: string) => {
            lockedIntentKind = k;
          },
        },
      ),
      chunks,
    )) as string | null;

    const continuation = await runToolEngineSeam({
      synthesis,
      chosenAction: relayedAction,
      lockedIntentKind,
      processMessage: processMessageFn as never,
    });

    return { calls, relayedAction, continuation };
  }

  it("execute_plan over a 2-phase plan calls processMessage exactly 2 times, not 3", async () => {
    const { calls, continuation } = await runSeam({
      planCardAnswer: "execute_plan",
      p0Verify: "exit 0",
      p1Verify: "exit 0",
    });
    expect(calls).toHaveLength(2);
    // The extra turn's fingerprint: the prose block built from the raw synthesis.
    expect(continuation).toBeNull();
    expect(calls.some((c) => c.includes("Implement this now"))).toBe(false);
  }, 30_000);

  it("a HALT on P0's failed verify does not then run the whole thing anyway", async () => {
    // The halt guarantee is the point of the per-phase gate. An ungated
    // continuation firing one statement later voids it entirely.
    const { calls, continuation } = await runSeam({
      planCardAnswer: "execute_plan",
      p0Verify: "exit 1",
      p1Verify: "exit 0",
    });
    expect(calls).toHaveLength(1); // P0 ran, verify failed, P1 never started
    expect(continuation).toBeNull();
  }, 30_000);

  it("save_exit on the post-plan card runs nothing at all", async () => {
    const { calls, continuation, relayedAction } = await runSeam({
      planCardAnswer: "save_exit",
      p0Verify: "exit 0",
      p1Verify: "exit 0",
    });
    expect(calls).toHaveLength(0);
    expect(continuation).toBeNull();
    // The relayed action must describe what the run ACTUALLY ended on, not the
    // "implement" pick that only requested a plan.
    expect(relayedAction).not.toBe("implement");
  }, 30_000);

  it("I8 — the session is marked completed AFTER the last phase, not before the first", async () => {
    // `postDebateAction` on this path is "execute_plan"/"implement", never
    // "continue_session", so the completed-status block (which used to sit ABOVE
    // Phase E) fired first and every message the N phase turns then wrote landed
    // on a session already flagged done — it dropped out of the resume picker
    // mid-run.
    const { calls } = await runSeam({ planCardAnswer: "execute_plan", p0Verify: "exit 0", p1Verify: "exit 0" });
    expect(calls).toHaveLength(2);
    expect(timeline).toEqual(["phase:1", "phase:2", "session:completed"]);
  }, 30_000);

  it("Esc on the post-plan card runs nothing at all", async () => {
    const { calls, continuation } = await runSeam({
      planCardAnswer: COUNCIL_ANSWER_DISMISSED,
      p0Verify: "exit 0",
      p1Verify: "exit 0",
    });
    expect(calls).toHaveLength(0);
    expect(continuation).toBeNull();
  }, 30_000);
});
