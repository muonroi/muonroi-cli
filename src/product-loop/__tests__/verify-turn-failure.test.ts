/**
 * verify-turn-failure.test.ts — a `/ideal` verify turn that was KILLED must not
 * be scored as a verify that finished.
 *
 * `sprint-runner.buildVerifyAgent.runTaskRequest` consumes a nested
 * `processMessageFn` turn and keeps only its `content` chunks, then returns
 * `{success:true, output}` unconditionally. Every other chunk is discarded —
 * `error` included. So when that nested turn is killed (the top-level turn
 * watchdog at orchestrator.ts:3708-3709 yields `error` then `done`; a provider
 * stall; a thrown provider error) the verify agent still reports success with
 * whatever partial text arrived before the kill, `parseVerifyResult` reads that
 * truncated payload, and the sprint is scored on a verify that never finished.
 *
 * That is the same failure shape the sibling defect had at the FORWARDING
 * consumers, fixed in `0534f5dd` (src/product-loop/nested-turn.ts). These two
 * COLLECTING consumers were missed because the sibling fix was pinned with a
 * builder-only test, so these tests drive the REAL `runSprint` through the real
 * `buildVerifyAgent` closure and the real `evaluateDoneGate`, and assert on the
 * sprint verdict that actually follows.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Verbatim chunk shapes the orchestrator emits (orchestrator.ts:3690-3709). */
const WATCHDOG_ERROR = {
  type: "error",
  content: "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung",
  isAuthError: false,
} as const;
const TURN_DONE = { type: "done" } as const;

/** The prompt our `runVerifyOrchestration` stand-in hands the REAL verify agent. */
const VERIFY_PROMPT = "verify please";

const RECIPE = { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] };

/**
 * Hoisted so the `vi.mock` factory below (which vitest lifts above the imports)
 * can close over it without a TDZ error.
 */
const h = vi.hoisted(() => ({
  // biome-ignore lint/suspicious/noExplicitAny: captured production values, shape asserted per-test
  gateCalls: [] as Array<{ ctx: any; verdict: any }>,
}));

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(() =>
    (async function* () {
      yield { type: "content", content: "planning…" };
      return "synthesis text from council";
    })(),
  ),
}));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
// The REAL done-gate runs; the wrapper only records what it was asked and what
// it answered. A stubbed gate would prove nothing about the sprint verdict.
vi.mock("../done-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../done-gate.js")>();
  return {
    ...actual,
    // biome-ignore lint/suspicious/noExplicitAny: DoneGateContext is structural here
    evaluateDoneGate: vi.fn(async (ctx: any) => {
      const verdict = await actual.evaluateDoneGate(ctx);
      h.gateCalls.push({ ctx, verdict });
      return verdict;
    }),
  };
});
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false, reason: "" })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({ recordProductSpend: vi.fn(async () => undefined) }));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { isRecallNagSuppressed, RECALL_NAG_SENTINEL } from "../../ee/recall-ledger.js";
import type { ToolResult } from "../../types/index.js";
import { logger } from "../../utils/logger.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState, ProductSpec, RoleSlot } from "../types.js";
import { VERIFY_PASS_MARKER } from "../verify-result.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const ENV_KEYS = ["MUONROI_IDEAL_ADHERENCE_REVIEW", "MUONROI_SPRINT_SKIP_VERIFY"];

let flowDir = "";
let projectCwd = "";
const prevEnv: Record<string, string | undefined> = {};
/** The ToolResult the REAL verify agent closure returned. */
let capturedVerify: ToolResult | undefined;
/** Sampled inside the verify turn's own stream — the boundary under test. */
let suppressedDuringVerify: boolean | null = null;
/** Script the verify turn replays. */
let verifyScript: Array<Record<string, unknown>> = [];

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "verify-fail-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "verify-fail-cwd-"));
  vi.clearAllMocks();
  h.gateCalls.length = 0;
  capturedVerify = undefined;
  suppressedDuringVerify = null;
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  // Not the seam under test, and it needs a git diff.
  process.env.MUONROI_IDEAL_ADHERENCE_REVIEW = "0";
  delete process.env.MUONROI_SPRINT_SKIP_VERIFY;
  verifyScript = [{ type: "content", content: `ran the gates\n${VERIFY_PASS_MARKER}\n` }, TURN_DONE];

  // Calling THROUGH the agent sprint-runner built exercises the production
  // closure (`buildVerifyAgent.runTaskRequest`) rather than a stand-in.
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runVerifyOrchestration as any).mockImplementation(async (agent: any) => {
    const r = (await agent.runTaskRequest({
      agent: "verify",
      description: "d",
      prompt: VERIFY_PROMPT,
    })) as ToolResult;
    capturedVerify = r;
    return { ...r, verifyRecipe: RECIPE };
  });
});

afterEach(() => {
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
});

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  } as ProductSpec;
}

function makeCtx(): unknown {
  return {
    runId: "run-verify-fail",
    flowDir,
    cwd: projectCwd,
    idea: "test idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn((prompt: string) =>
      (async function* () {
        if (prompt === VERIFY_PROMPT) {
          suppressedDuringVerify = isRecallNagSuppressed();
          for (const c of verifyScript) yield c;
          return;
        }
        yield { type: "content", content: "implementing…" };
        yield TURN_DONE;
      })(),
    ),
    detectVerifyRecipe: vi.fn(async () => RECIPE),
  };
}

/** Run one sprint to completion and hand back its IterationState. */
async function runOneSprint(): Promise<IterationState | undefined> {
  const gen = runSprint({
    sprintN: 1,
    ctx: makeCtx() as never,
    productSpec: makeSpec(),
    roleAssignments: NO_ROLES,
    history: [],
  });
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value as IterationState;
  }
}

describe("/ideal verify agent — a killed nested turn is not a successful verify", () => {
  it("watchdog kill (partial text with a PASS marker, then error, then done) does not report success, and the sprint verdict is not a PASS", async () => {
    // The measured shape that makes this dangerous: the sub-agent narrated a
    // PASS before the kill, so the truncated payload READS like a green run.
    verifyScript = [
      { type: "content", content: `running the suite…\n${VERIFY_PASS_MARKER}\n` },
      WATCHDOG_ERROR,
      TURN_DONE,
    ];

    const iter = await runOneSprint();

    // 1. The verify agent's own answer.
    expect(capturedVerify?.success).toBe(false);
    expect(capturedVerify?.error ?? "").toContain("Turn ended by watchdog");
    // The partial narration is still handed on — it is the only evidence there is.
    expect(capturedVerify?.output ?? "").toContain("running the suite");

    // 2. The verdict the sprint was actually scored with.
    expect(iter?.lastVerifyResult).not.toBe("PASS");
    expect(iter?.lastVerifyResult).toBe("ERROR");
    expect(iter?.stage).toBe("retrospective");

    // 3. The done-gate failed on the verify, not on something downstream.
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0].verdict.pass).toBe(false);
    expect(h.gateCalls[0].verdict.failedCondition).toBe("engineering_floor");
    expect(h.gateCalls[0].verdict.reason).toBe("verify_FAIL");
  }, 120_000);

  it("a verify turn that completes normally is unchanged — success, no error, PASS verdict", async () => {
    verifyScript = [{ type: "content", content: `ran the gates\n${VERIFY_PASS_MARKER}\n` }, TURN_DONE];

    const iter = await runOneSprint();

    expect(capturedVerify?.success).toBe(true);
    expect(capturedVerify?.error ?? "").toBe("");
    expect(iter?.lastVerifyResult).toBe("PASS");
    // The floor opened, so the sprint fails LATER (empty criteria ⇒ score 0),
    // never at the engineering floor. That is the control this test pins.
    expect(h.gateCalls[0].verdict.failedCondition).toBe("weighted_score");
  }, 120_000);

  it("an `error` the turn RECOVERED from (error, more content, normal end) is not a failure", async () => {
    verifyScript = [
      { type: "content", content: "first attempt hiccuped\n" },
      WATCHDOG_ERROR,
      { type: "content", content: `retried and finished\n${VERIFY_PASS_MARKER}\n` },
      TURN_DONE,
    ];

    const iter = await runOneSprint();

    expect(capturedVerify?.success).toBe(true);
    expect(capturedVerify?.error ?? "").toBe("");
    expect(iter?.lastVerifyResult).toBe("PASS");
  }, 120_000);

  it("a nested turn whose stream ENDS right after an error (no `done` chunk) is also a failure", async () => {
    // Not every failure path yields a `done`: an aborted stream just stops. The
    // terminator is "done, or the end of the stream".
    verifyScript = [{ type: "content", content: `partial\n${VERIFY_PASS_MARKER}\n` }, WATCHDOG_ERROR];

    const iter = await runOneSprint();

    expect(capturedVerify?.success).toBe(false);
    expect(iter?.lastVerifyResult).toBe("ERROR");
  }, 120_000);
});

describe("/ideal verify agent — the recall-nag boundary survives the failure path", () => {
  it("suppression is ON during a KILLED verify turn and released afterwards", async () => {
    verifyScript = [{ type: "content", content: "working…" }, WATCHDOG_ERROR, TURN_DONE];

    await runOneSprint();

    expect(suppressedDuringVerify).toBe(true);
    // A leaked scope would silently mute the nag for the rest of the session.
    expect(isRecallNagSuppressed()).toBe(false);
  }, 120_000);

  it("the tripwire still fires when a nag reaches the payload of a KILLED verify turn", async () => {
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      verifyScript = [
        { type: "content", content: `↳ 6 earlier ${RECALL_NAG_SENTINEL} — rate them\n` },
        WATCHDOG_ERROR,
        TURN_DONE,
      ];

      await runOneSprint();

      expect(
        errSpy.mock.calls.some((c) => typeof c[1] === "string" && c[1].includes("machine-read boundary has a hole")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  }, 120_000);

  it("the tripwire still fires on a verify turn that completed normally", async () => {
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      verifyScript = [
        { type: "content", content: `↳ 6 earlier ${RECALL_NAG_SENTINEL} — rate them\n${VERIFY_PASS_MARKER}\n` },
        TURN_DONE,
      ];

      await runOneSprint();

      expect(
        errSpy.mock.calls.some((c) => typeof c[1] === "string" && c[1].includes("machine-read boundary has a hole")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  }, 120_000);

  it("the tripwire stays quiet when no nag reached the payload", async () => {
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      verifyScript = [{ type: "content", content: `clean run\n${VERIFY_PASS_MARKER}\n` }, TURN_DONE];

      await runOneSprint();

      expect(
        errSpy.mock.calls.some((c) => typeof c[1] === "string" && c[1].includes("machine-read boundary has a hole")),
      ).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  }, 120_000);
});
