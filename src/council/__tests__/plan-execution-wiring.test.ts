/**
 * D3/Task 8 — the "implement" handoff wiring end-to-end: post-debate card
 * ("implement") → runPlannerPhase drafts PLAN.md → runPlanReview reviews it
 * (and writes PLAN-VERIFY.md) → buildPostPlanCard is shown → "execute_plan"
 * drives Phase E's runPlanExecution loop, one phase per turn, gated on that
 * phase's own verify command.
 *
 * This is the loop the whole design exists for: before this wiring,
 * "implement" fell straight through to persistence and the RAW synthesis
 * prose was fed back through processMessage next turn, where PIL classified
 * it taskType=analyze/deliverable=report (interaction_logs id 2498, session
 * 3a8378db4adf) instead of running as code.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planningArtifact } from "../../gsd/paths.js";
import { readPlanVerifyVerdict } from "../../gsd/workflow-engine.js";
import { isCouncilPlanExecution } from "../../pil/layer6-output.js";
import type { StreamChunk } from "../../types/index.js";
import { COUNCIL_ANSWER_DISMISSED } from "../types.js";

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
    { role: "analyst", model: "mock-a", position: "final position A" },
    { role: "critic", model: "mock-b", position: "final position B" },
  ]),
  // Cost-aware is off in this test env, so the real implementation is a no-op
  // (returns leaderModelId unchanged) — mocked directly rather than partially
  // importing the real module to keep this file's mocks self-contained.
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

const PLANNER_JSON = [
  "```json",
  JSON.stringify({
    phases: [
      {
        id: "P0",
        title: "Sentinel",
        steps: ["Add the spy"],
        files: ["src/council/index.ts"],
        acceptance: ["Sentinel wins end to end"],
        // A no-op command that exits 0 on both cmd.exe and POSIX sh (spawnSync
        // shell:true) so verifyPhase passes deterministically in CI.
        verify: "exit 0",
      },
    ],
  }),
  "```",
].join("\n");

const APPROVE_VERDICT = ["```council-verdict", JSON.stringify({ verdict: "approve", concerns: [] }), "```"].join("\n");

/**
 * generate() is hit an UNPREDICTABLE number of times before synthesis (leader
 * round-eval, opening, etc. all route through the same CouncilLLM.generate —
 * see debate.ts), so a simple call-order queue is the wrong tool: the planner
 * and reviewer calls would race whatever count the debate itself consumes.
 * Branch on the PROMPT CONTENT instead — buildPlannerPrompt and
 * buildReviewPrompt each have a distinctive, stable marker string.
 */
function buildMockLLM(reviewVerdict: string) {
  return {
    generate: vi.fn().mockImplementation(async (_modelId: string, _system: string, prompt: string) => {
      if (prompt.includes("You are the council PLANNER")) return PLANNER_JSON;
      if (prompt.includes("--- PLAN.md ---")) return reviewVerdict;
      return SYNTHESIS_JSON;
    }),
    research: vi.fn().mockResolvedValue("## Source Code Findings\n- [docs/Council.md:42] flow"),
    debate: vi.fn().mockResolvedValue({ text: "Position [CONFIRMED via docs/Council.md:42]", toolCalls: [] }),
  };
}

/**
 * Drains the generator into `chunks` while answering every council_question by
 * inspecting the OPTION VALUES of the card actually shown, not call order.
 * Needed because the debate can interject its own B4 escalation card — which
 * deliberately reuses phase "post-debate" (debate.ts:2708) — ahead of the real
 * post-debate card, so a position-based script answers the wrong card.
 * `planCardAnswer` decides the answer once the post-plan card (execute_plan /
 * revise_plan / save_exit) appears.
 */
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

async function drain(gen: AsyncGenerator<StreamChunk, unknown, unknown>, chunks: StreamChunk[]): Promise<unknown> {
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return step.value;
}

const isPostPlanCard = (c: StreamChunk) => c?.type === "council_question" && c?.councilQuestion?.phase === "post-plan";

describe("implement -> plan draft -> review -> post-plan card -> execute_plan", () => {
  let cwd: string;

  // Snapshot-and-restore, not delete — this repo adopted this convention
  // after a fileParallelism env-leak flake (see leader-conductor.test.ts for
  // the same pattern): a bare `delete` would clobber a value the surrounding
  // shell or another concurrent file legitimately set.
  let prevEscalate: string | undefined;

  beforeEach(() => {
    // The B4 interactive escalation card is orthogonal to what's under test
    // here (the "implement" -> plan -> review -> execute handoff), and the
    // minimal debate mock below (identical text every round) makes the debate
    // look "stuck" and hit the round ceiling — disable it so the run reaches a
    // clean, high-trust synthesis instead of a degraded one that would
    // legitimately reroute "implement" into a follow-up (resolvePhaseOutcomeTransition).
    prevEscalate = process.env.MUONROI_COUNCIL_ESCALATE;
    process.env.MUONROI_COUNCIL_ESCALATE = "0";
  });

  afterEach(() => {
    if (prevEscalate === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
    else process.env.MUONROI_COUNCIL_ESCALATE = prevEscalate;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("execute_plan drives runPlanExecution, marks the phase done, and every processMessage call carries the marker", async () => {
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const seenPrompts: string[] = [];
    // I5 — sample the gate token from INSIDE a phase turn. That is the only
    // moment it is supposed to be open, and the only way to tell "the unlock
    // worked" apart from "the unlock leaked" once it is restored below.
    const verdictDuringPhase: Array<string | null> = [];
    const processMessageFn = vi.fn().mockImplementation(async function* (message: string) {
      seenPrompts.push(message);
      verdictDuringPhase.push(readPlanVerifyVerdict(cwd));
      yield { type: "done" };
    });

    const { chunks, respondToQuestion } = buildAnswerer("execute_plan");

    const ret = await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-exec-plan",
        buildMockLLM(APPROVE_VERDICT),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, cwd },
      ),
      chunks,
    );
    void ret;

    // The post-plan card was actually shown, distinct from the post-debate card.
    expect(chunks.some(isPostPlanCard)).toBe(true);

    // The reviewed plan is what drove execution — the phase prompt carries the
    // marker pipeline.ts routes on, and processMessage was actually invoked
    // for the phase (not the raw synthesis prose).
    expect(processMessageFn).toHaveBeenCalledTimes(1);
    expect(seenPrompts).toHaveLength(1);
    expect(isCouncilPlanExecution(seenPrompts[0])).toBe(true);
    expect(seenPrompts[0]).toContain("P0");
    expect(seenPrompts[0]).toContain("Sentinel wins end to end");

    // PLAN.md was ticked done after the phase's verify command passed.
    const planPath = planningArtifact(cwd, "PLAN.md");
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, "utf8")).toContain("**Status:** done");

    // PLAN-VERIFY.md unlocked the GSD mutation gate WHILE the phase turn ran —
    // the second half of the fix (Task 8's investigation into mutation-gate.ts).
    expect(verdictDuringPhase).toEqual(["pass"]);

    // I5 — …and the unlock is SCOPED to this run. These are cwd-scoped files
    // that canExecute reads on every later turn in the repo
    // (workflow-engine.ts:227-243); leaving them would hold the heavy-depth
    // mutation gate open indefinitely for any subsequent turn in this project,
    // including one that never ran a council. The cwd had no PLAN-VERIFY.md
    // before the run, so it must have none after it.
    expect(readPlanVerifyVerdict(cwd)).toBeNull();
    expect(existsSync(planningArtifact(cwd, "PLAN-VERIFY.md"))).toBe(false);
    // The REVIEW itself is the audit trail and is deliberately kept.
    expect(existsSync(planningArtifact(cwd, "PLAN-REVIEW.md"))).toBe(true);
    // The plan the phases executed also stays on disk.
    expect(existsSync(planningArtifact(cwd, "PLAN.md"))).toBe(true);
  });

  it("I7 — a throw from a phase turn is contained: the run still emits its terminal done", async () => {
    // Phase E sits AFTER the post-debate try/catch closes and now drives N full
    // agent turns. An escaping throw would skip the stats block AND the terminal
    // `{type:"done"}` — and on the slash path orchestrator.ts's `innerDoneSeen`
    // re-emit too, so the TUI consumer's `for await` would never see its break
    // boundary and the turn would hang mounted.
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "content", content: "starting" };
      throw new Error("provider exploded mid-phase");
    });
    const { chunks, respondToQuestion } = buildAnswerer("execute_plan");

    await expect(
      drain(
        runCouncil(
          "Add a sentinel",
          "mock-model",
          [],
          "sess-exec-throw",
          buildMockLLM(APPROVE_VERDICT),
          respondToQuestion,
          vi.fn().mockResolvedValue(true),
          processMessageFn,
          { skipClarification: true, cwd },
        ),
        chunks,
      ),
    ).resolves.toBeDefined();

    expect(processMessageFn).toHaveBeenCalled();
    // Terminal chunk reached the consumer.
    expect(chunks.some((c) => c.type === "done")).toBe(true);
    // The failure is reported, not swallowed, and points at the saved plan.
    expect(chunks.some((c) => c.type === "content" && c.content?.includes("provider exploded mid-phase"))).toBe(true);
    // I5 still runs on the throw path — the gate must not be left open.
    expect(readPlanVerifyVerdict(cwd)).toBeNull();
  });

  it("pressing Esc on the post-plan card NEVER launches execution, even though execute_plan is the approve default", async () => {
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });
    // On an approve verdict, buildPostPlanCard's defaultIndex IS execute_plan
    // (index.ts:~527). Collapsing Esc into "take the default" here — as an
    // empty-submit answer correctly does — would make closing the card start
    // N agent turns that edit code and shell out. Esc must resolve to
    // save_exit, mirroring the post-debate card's own dismiss handling.
    const { chunks, respondToQuestion } = buildAnswerer(COUNCIL_ANSWER_DISMISSED);

    await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-esc-post-plan",
        buildMockLLM(APPROVE_VERDICT),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, cwd },
      ),
      chunks,
    );

    expect(chunks.some(isPostPlanCard)).toBe(true);
    expect(processMessageFn).not.toHaveBeenCalled();
    const planPath = planningArtifact(cwd, "PLAN.md");
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, "utf8")).not.toContain("**Status:** done");
  });

  it("an empty submit on the post-plan card takes the card's default (execute_plan on approve)", async () => {
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const seenPrompts: string[] = [];
    const processMessageFn = vi.fn().mockImplementation(async function* (message: string) {
      seenPrompts.push(message);
      yield { type: "done" };
    });
    // "" is a real, distinct signal from COUNCIL_ANSWER_DISMISSED — a freetext
    // option submitted with nothing typed. This must still resolve to the
    // card's own recommended default, exactly like the post-debate card.
    const { chunks, respondToQuestion } = buildAnswerer("");

    await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-empty-post-plan",
        buildMockLLM(APPROVE_VERDICT),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, cwd },
      ),
      chunks,
    );

    expect(chunks.some(isPostPlanCard)).toBe(true);
    expect(processMessageFn).toHaveBeenCalledTimes(1);
    expect(seenPrompts).toHaveLength(1);
    expect(isCouncilPlanExecution(seenPrompts[0])).toBe(true);
    const planPath = planningArtifact(cwd, "PLAN.md");
    expect(readFileSync(planPath, "utf8")).toContain("**Status:** done");
  });

  it("save_exit on the post-plan card saves PLAN.md but does not execute", async () => {
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });
    const { chunks, respondToQuestion } = buildAnswerer("save_exit");

    await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-save-exit",
        buildMockLLM(APPROVE_VERDICT),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, cwd },
      ),
      chunks,
    );

    expect(chunks.some(isPostPlanCard)).toBe(true);
    expect(processMessageFn).not.toHaveBeenCalled();
    const planPath = planningArtifact(cwd, "PLAN.md");
    expect(existsSync(planPath)).toBe(true);
    // Plan was reviewed and approved, but the user chose not to run it — PLAN.md
    // must NOT be marked done (nothing executed).
    expect(readFileSync(planPath, "utf8")).not.toContain("**Status:** done");
  });

  it("a block verdict does not offer execute_plan, and Phase E never fires", async () => {
    cwd = mkdtempSync(join(tmpdir(), "council-plan-exec-"));
    const { runCouncil } = await import("../index.js");

    const blockVerdict = ["```council-verdict", JSON.stringify({ verdict: "block", concerns: ["unsafe"] }), "```"].join(
      "\n",
    );
    const processMessageFn = vi.fn().mockImplementation(async function* () {
      yield { type: "done" };
    });
    // The post-plan card on a block has no execute_plan option, so
    // runAndAnswer's revise/save fallback ("save_exit") never reaches
    // execute_plan — the revision loop below only advances via "revise_plan".
    const { chunks, respondToQuestion } = buildAnswerer("save_exit");

    await drain(
      runCouncil(
        "Add a sentinel",
        "mock-model",
        [],
        "sess-block",
        buildMockLLM(blockVerdict),
        respondToQuestion,
        vi.fn().mockResolvedValue(true),
        processMessageFn,
        { skipClarification: true, cwd },
      ),
      chunks,
    );

    const planCard = chunks.find(isPostPlanCard);
    expect(planCard).toBeTruthy();
    const execOption = planCard?.councilQuestion?.options?.find((o) => o.value === "execute_plan");
    expect(execOption).toBeUndefined();
    expect(processMessageFn).not.toHaveBeenCalled();
  });
});
