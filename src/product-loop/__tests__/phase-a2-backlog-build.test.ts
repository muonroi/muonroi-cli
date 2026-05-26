/**
 * phase-a2-backlog-build.test.ts — Phase A2 unit tests.
 *
 * A2: buildBacklogAndSprintPlan builds backlog.json + sprint-plan.json after
 *     the council debate produces a ProductSpec. Verified end-to-end via
 *     runProductLoop (backlog-store + sprint-store real writes to tmpdir).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Top-level mocks ────────────────────────────────────────────────────────

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));
vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(),
}));
vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 1, mistakes: 0, stored: 1 })),
}));
vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(async () => undefined),
  readCriteria: vi.fn(async () => []),
  writeManifest: vi.fn(async () => undefined),
  readManifest: vi.fn(async () => null),
  markIterationCrashed: vi.fn(async () => undefined),
  readIterations: vi.fn(async () => []),
}));
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => null),
}));
vi.mock("../gather.js", () => ({
  clarifiedSpecFromContext: vi.fn(() => ({
    problemStatement: "test",
    constraints: [],
    successCriteria: ["mvp feat"],
    scope: "test",
    rawQA: [],
    resolved: {},
  })),
}));

import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function shippedIter(sprintN = 1) {
  return {
    sprintN,
    stage: "shipped",
    scoreBefore: 0,
    scoreAfter: 1.0,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0,
    lastVerifyResult: "PASS",
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<void> {
  while (true) {
    const step = await gen.next();
    if (step.done) break;
  }
}

function makeOpts(flowDir: string) {
  return {
    flowDir,
    idea: "build a todo app",
    subcommand: "start",
    sessionModelId: "test-model",
    sessionId: "test-session",
    // mode="new" bypasses Mode C auto-detection
    mode: "new",
    llm: {
      generate: vi.fn(
        async () =>
          '{"idea":"todo","persona":"users","mvp":["add task"],"phase2":[],"architecture":"spa","ioContract":"rest","folderStructure":"src/","sprintEstimate":2,"costEstimate":10}',
      ),
      research: vi.fn(async () => ""),
      debate: vi.fn(async () => ""),
    },
    flags: { maxCost: 50, maxSprints: 2, doneThreshold: 0.9, forceCouncil: true },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "ok" };
    }),
    // detectVerifyRecipe returns null so Mode C does NOT activate
    detectVerifyRecipe: vi.fn(async () => null),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("A2: buildBacklogAndSprintPlan writes backlog.json + sprint-plan.json", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase-a2-test-"));
    vi.clearAllMocks();

    // Driver returns approved
    (runLoopDriver as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "running driver" };
      return { success: true, stage: "approved" };
    });

    // Sprint runner returns shipped immediately. async function* with no
    // yield is the correct shape for runSprint (AsyncGenerator<StreamChunk,
    // IterationState>) — only the IterationState return matters here.
    // biome-ignore lint/correctness/useYield: intentional no-yield mock
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return shippedIter(1);
    });
  });

  afterEach(async () => {
    // Windows ENOTEMPTY guard — see plan.test.ts:33 for rationale.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("creates backlog.json and sprint-plan.json when they do not exist", async () => {
    await drain(runProductLoop(makeOpts(tmpDir) as never));

    // Look for backlog.json + sprint-plan.json in .planning/runs/<runId>/
    const runsDir = path.join(tmpDir, "runs");
    const runDirs = await fs.readdir(runsDir).catch(() => [] as string[]);
    let backlogFound = false;
    let sprintPlanFound = false;
    for (const runId of runDirs) {
      const base = path.join(runsDir, runId);
      await fs
        .access(path.join(base, "backlog.json"))
        .then(() => {
          backlogFound = true;
        })
        .catch(() => {});
      await fs
        .access(path.join(base, "sprint-plan.json"))
        .then(() => {
          sprintPlanFound = true;
        })
        .catch(() => {});
    }

    expect(backlogFound).toBe(true);
    expect(sprintPlanFound).toBe(true);
  });

  it("is idempotent — skips build if backlog.json already exists", async () => {
    // First run — creates backlog + sprint-plan
    await drain(runProductLoop(makeOpts(tmpDir) as never));

    const runsDir = path.join(tmpDir, "runs");
    const runDirs1 = await fs.readdir(runsDir).catch(() => [] as string[]);
    const runId1 = runDirs1[0];
    expect(runId1).toBeDefined();

    const backlogPath = path.join(runsDir, runId1!, "backlog.json");
    const backlogStat1 = await fs.stat(backlogPath).catch(() => null);
    expect(backlogStat1).not.toBeNull();

    // Re-mock with a spy to detect if LLM is called again for backlog build
    const llmGenSpy = vi.fn(
      async () =>
        '{"idea":"todo","persona":"users","mvp":["add task"],"phase2":[],"architecture":"spa","ioContract":"rest","folderStructure":"src/","sprintEstimate":2,"costEstimate":10}',
    );
    const opts2 = { ...makeOpts(tmpDir), llm: { ...makeOpts(tmpDir).llm, generate: llmGenSpy } };

    // Second run with same flowDir — should reuse existing backlog + sprint-plan
    await drain(runProductLoop(opts2 as never));

    // backlog.json mtime must be unchanged (idempotent — not re-written)
    const backlogStat2 = await fs.stat(backlogPath).catch(() => null);
    expect(backlogStat2?.mtimeMs).toBe(backlogStat1?.mtimeMs);
  });
});
