/**
 * maintain-verify-turn-failure.test.ts — the Mode C verify agent has the same
 * defect as `/ideal`'s: `buildVerifyAgent.runTaskRequest` (task-runner.ts:477)
 * consumes a nested `processMessageFn` turn, keeps only its `content` chunks and
 * returns `{success:true, output}` unconditionally. `error` is discarded, so a
 * turn killed by the top-level turn watchdog (orchestrator.ts:3708-3709 yields
 * `error` then `done`), by a provider stall, or by a thrown provider error still
 * reports a successful verify over a truncated payload.
 *
 * `evaluateDoneGate` then reads that payload through `parseVerifyResult`: a
 * partial narration that already contained `VERIFY_PASS` clears the engineering
 * floor, and the judge's failure reason points at some LATER condition instead of
 * at the verify that never finished.
 *
 * These tests drive the REAL `runMaintenanceTask` through the REAL verify-agent
 * closure and the REAL `evaluateDoneGate` — the sibling fix in `0534f5dd` was
 * pinned with a builder-only test, which is how this site was missed.
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

// `done-gate.js` is deliberately NOT mocked — the verdict under test is the one
// the real gate produces from the real ToolResult.
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../../council/leader.js", () => ({
  pickCouncilTaskModel: vi.fn((_task: string, leaderId: string) => leaderId),
}));

import { isRecallNagSuppressed } from "../../ee/recall-ledger.js";
import type { ToolResult, VerifyRecipe } from "../../types/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import type { MaintenanceCtx, RunMaintenanceTaskInput } from "../task-runner.js";
import { runMaintenanceTask } from "../task-runner.js";
import type { CodebaseIntel, MaintenanceTask } from "../types.js";

const RECIPE: VerifyRecipe = {
  ecosystem: "node",
  appKind: "cli",
  appLabel: "Test project",
  shellInitCommands: [],
  bootstrapCommands: [],
  installCommands: [],
  buildCommands: [],
  testCommands: ["npm test"],
  smokeKind: "none",
  evidence: [],
  notes: [],
  coverage: 80,
} as unknown as VerifyRecipe;

/** The ToolResult the REAL verify agent closure returned. */
let capturedVerify: ToolResult | undefined;
/** Sampled inside the verify turn's own stream — the nag boundary under test. */
let suppressedDuringVerify: boolean | null = null;
/** Script the verify turn replays. */
let verifyScript: Array<Record<string, unknown>> = [];
/** Throwaway cwd — `writePreEditMarker` writes `.planning/runs/<id>/` into it. */
let projectCwd = "";

function makeTask(): MaintenanceTask {
  return {
    id: "01HX1234",
    kind: "bug",
    title: "Fix login redirect",
    description: "After login the user is redirected to /undefined instead of /dashboard",
    acceptance_criteria: ["redirect to /dashboard after login"],
    candidateFiles: ["src/auth/login.ts"],
    impactRadius: [],
    regressionTestFiles: [],
    status: "queued",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
  } as MaintenanceTask;
}

function makeIntel(): CodebaseIntel {
  return {
    cwd: "/tmp/proj",
    repoMap: "src/\n  auth/\n    login.ts",
    repoMapSource: "generated",
    candidateFiles: [{ path: "src/auth/login.ts", reason: "filename match", matchScore: 0.9 }],
    impactRadius: [],
    regressionTests: [],
    detectedFrameworks: ["node"],
    capturedAtUtc: new Date().toISOString(),
  } as unknown as CodebaseIntel;
}

function makeCtx(): MaintenanceCtx {
  return {
    runId: "run-maint-verify-fail",
    sessionId: "sess-test",
    cwd: projectCwd,
    llm: { generate: vi.fn(async () => "1. Fix redirect in login.ts") },
    processMessageFn: vi.fn((prompt: string) =>
      (async function* () {
        if (prompt === VERIFY_PROMPT) {
          suppressedDuringVerify = isRecallNagSuppressed();
          for (const c of verifyScript) yield c;
          return;
        }
        yield { type: "content", content: "applying fix…" };
        yield TURN_DONE;
      })(),
    ),
    detectVerifyRecipe: vi.fn(async () => RECIPE),
    respondToPreflight: vi.fn(async () => true),
  } as unknown as MaintenanceCtx;
}

function makeInput(): RunMaintenanceTaskInput {
  return {
    task: makeTask(),
    codebaseIntel: makeIntel(),
    ctx: makeCtx(),
    leaderModelId: "leader-model",
    costAware: true,
  } as unknown as RunMaintenanceTaskInput;
}

async function run() {
  const gen = runMaintenanceTask(makeInput());
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  projectCwd = mkdtempSync(join(tmpdir(), "maint-verify-cwd-"));
  capturedVerify = undefined;
  suppressedDuringVerify = null;
  verifyScript = [{ type: "content", content: "ran the gates\nVERIFY_PASS\n" }, TURN_DONE];
  // Calling THROUGH the agent task-runner built exercises the production
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
  vi.clearAllMocks();
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("maintain verify agent — a killed nested turn is not a successful verify", () => {
  it("watchdog kill (partial text with a PASS marker, then error, then done) does not report success, and the judge blocks on the verify", async () => {
    verifyScript = [{ type: "content", content: "running the suite…\nVERIFY_PASS\n" }, WATCHDOG_ERROR, TURN_DONE];

    const result = await run();

    expect(capturedVerify?.success).toBe(false);
    expect(capturedVerify?.error ?? "").toContain("Turn ended by watchdog");
    expect(capturedVerify?.output ?? "").toContain("running the suite");

    // The real done-gate must fail at condition #1 on the verify, not slide past
    // it and fail somewhere downstream.
    expect(result.status).toBe("blocked");
    expect(result.failureReason).toBe("verify_FAIL");
  }, 60_000);

  it("a verify turn that completes normally is unchanged — success, and the floor opens", async () => {
    verifyScript = [{ type: "content", content: "ran the gates\nVERIFY_PASS\n" }, TURN_DONE];

    const result = await run();

    expect(capturedVerify?.success).toBe(true);
    expect(capturedVerify?.error ?? "").toBe("");
    // The engineering floor is cleared; the task is blocked LATER, on the score
    // (Mode C marks every acceptance criterion `unmet` until a human judges it).
    // That is the control: the verify itself was accepted.
    expect(result.failureReason ?? "").toContain("score_below_threshold");
  }, 60_000);

  it("an `error` the turn RECOVERED from (error, more content, normal end) is not a failure", async () => {
    verifyScript = [
      { type: "content", content: "first attempt hiccuped\n" },
      WATCHDOG_ERROR,
      { type: "content", content: "retried and finished\nVERIFY_PASS\n" },
      TURN_DONE,
    ];

    const result = await run();

    expect(capturedVerify?.success).toBe(true);
    expect(capturedVerify?.error ?? "").toBe("");
    expect(result.failureReason ?? "").toContain("score_below_threshold");
  }, 60_000);

  it("keeps the recall-nag suppression scope: ON during a KILLED verify turn, released afterwards", async () => {
    verifyScript = [{ type: "content", content: "working…" }, WATCHDOG_ERROR, TURN_DONE];

    await run();

    expect(suppressedDuringVerify).toBe(true);
    expect(isRecallNagSuppressed()).toBe(false);
  }, 60_000);
});
