/**
 * S2 — plan-adherence review observability.
 *
 * `plan-adherence-review.ts` only yielded `StreamChunk`s to the transcript and
 * returned an in-memory `AdherenceVerdict`; nothing about what the reviewer
 * found, what the fixer did, or why the loop stopped survived past the sprint
 * that produced it (live run mu54vrme4c87: `sprints/` held only
 * `<n>-goal-gate.json`, `<n>-outcome.json`, `<n>-verify.md`). This pins that
 * `sprints/<n>-adherence.json` is now written for every outcome — approved,
 * fixed-then-approved, no-progress, and the caller's own env opt-out — through
 * the real `runSprint` → Step 4c wiring, and that a review which throws before
 * producing a verdict is still recorded rather than silently dropped.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { readSprintAdherence, type SprintAdherenceRecord } from "../../flow/run-artifacts.js";
import { loadCatalog } from "../../models/registry.js";
import type { TaskRequest, ToolResult } from "../../types/index.js";

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../verify-floor.js", () => ({
  // The shape `runVerifyFloor` really returns for an unavailable verdict
  // (verify-floor.ts:842-857) — see the same note in goal-gate-skip-record.test.ts.
  runVerifyFloor: vi.fn(async () => ({
    verdict: "unavailable",
    unavailableReason: "no-commands-discovered",
    detail: "held unavailable by the S2 fixture",
    checks: [],
    commandsDiscovered: { build: [], test: [] },
    measuredCoverage: null,
    elapsedMs: 0,
  })),
  resolveFloorCommands: () => ({ build: [], test: [] }),
  applyVerifyFloor: (current: string) => ({ verdict: current, downgraded: false, upgraded: false, note: "" }),
  readBaselineVerifyCostMs: vi.fn(async () => null),
}));
vi.mock("../verify-failure-tracking.js", () => ({
  loadVerifyFailureSignatures: vi.fn(async () => []),
  recordVerifyFailureAndMaybePush: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  recordProductSpend: vi.fn(async () => undefined),
}));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState, ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const RUN_ID = "run-s2-adherence";

let flowDir: string;
let projectCwd: string;

function makeSpec(): ProductSpec {
  return {
    idea: "make the analyzer warn in Visual Studio",
    persona: "devs",
    mvp: ["the warning shows in the IDE"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

/** Real repo so `git diff HEAD` (the review's diff source) has something to read. */
function seedRepo(): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: projectCwd, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "s2@test.local"]);
  run(["config", "user.name", "S2 fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectCwd, "analyzer.cs"), "// before\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  writeFileSync(join(projectCwd, "analyzer.cs"), "// before\n// the change under review\n", "utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: test driver context stand-in
function makeCtx(runIsolatedTask?: (req: TaskRequest) => Promise<ToolResult>): any {
  return {
    runId: RUN_ID,
    flowDir,
    cwd: projectCwd,
    idea: "make the analyzer warn in Visual Studio",
    sessionModelId: getTestModels().balanced,
    llm: {
      generate: vi.fn(async () => "synthesis"),
      research: vi.fn(async () => "research"),
    },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: [], coverage: 80, shellInitCommands: [] })),
    runIsolatedTask,
  };
}

async function runOneSprint(runIsolatedTask?: (req: TaskRequest) => Promise<ToolResult>): Promise<void> {
  await runOneSprintCapture(runIsolatedTask);
}

/** Like `runOneSprint`, but returns the final `IterationState` (e.g. to read `nextFocus`). */
async function runOneSprintCapture(
  runIsolatedTask?: (req: TaskRequest) => Promise<ToolResult>,
): Promise<IterationState> {
  const gen = runSprint({
    sprintN: 1,
    ctx: makeCtx(runIsolatedTask),
    productSpec: makeSpec(),
    roleAssignments: NO_ROLES,
    history: [],
  });
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "s2-adherence-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "s2-adherence-cwd-"));
  seedRepo();
  vi.clearAllMocks();
  // Isolated-impl OFF: implementation runs through processMessageFn so
  // ctx.runIsolatedTask is exercised ONLY by the adherence gate under test.
  process.env.MUONROI_SPRINT_ISOLATED_IMPL = "0";
  process.env.MUONROI_SPRINT_SELF_VERIFY = "0";
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "Everything looks good.\nVERIFY_PASS\n",
    verifyRecipe: { testCommands: [], coverage: 80, shellInitCommands: [] },
  });
});

afterEach(() => {
  delete process.env.MUONROI_SPRINT_ISOLATED_IMPL;
  delete process.env.MUONROI_SPRINT_SELF_VERIFY;
  delete process.env.MUONROI_IDEAL_ADHERENCE_REVIEW;
  delete process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS;
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function readRecord(): SprintAdherenceRecord | null {
  const p = join(flowDir, "runs", RUN_ID, "sprints", "1-adherence.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SprintAdherenceRecord;
}

describe("plan-adherence artifact — sprints/<n>-adherence.json", () => {
  it("approved in round 1: one round, no fix, stopReason approved", async () => {
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      expect(req.description).toContain("plan-adherence review");
      return { success: true, output: '{"adherent": true, "deviations": []}' };
    });

    await runOneSprint(runIsolatedTask);

    const rec = readRecord();
    expect(rec).not.toBeNull();
    expect(rec?.enabled).toBe(true);
    expect(rec?.finalVerdict).toBe(true);
    expect(rec?.stopReason).toBe("approved");
    expect(rec?.residualDeviations).toEqual([]);
    expect(rec?.rounds).toHaveLength(1);
    expect(rec?.rounds[0]?.reviewerApproved).toBe(true);
    expect(rec?.rounds[0]?.fixRan).toBe(false);
    expect(rec?.reviewModelId).toBeTruthy();
    expect(rec?.fixModelId).toBeTruthy();
    expect(rec?.sprintN).toBe(1);
    expect(rec?.runId).toBe(RUN_ID);
    expect(rec?.version).toBe(1);

    // Same shape the production reader returns.
    const viaReader = await readSprintAdherence(flowDir, RUN_ID, 1);
    expect(viaReader).toEqual(rec);
  });

  it("deviation -> fix -> approved: two rounds, fix ran once, stopReason approved", async () => {
    let reviewCalls = 0;
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("plan-adherence review")) {
        reviewCalls++;
        return reviewCalls === 1
          ? {
              success: true,
              output:
                '{"adherent": false, "deviations": [{"where":"analyzer.cs","issue":"wrong warning text","fix":"use the approved message"}]}',
            }
          : { success: true, output: '{"adherent": true, "deviations": []}' };
      }
      return { success: true, output: "applied the fix" };
    });

    await runOneSprint(runIsolatedTask);

    const rec = readRecord();
    expect(rec?.finalVerdict).toBe(true);
    expect(rec?.stopReason).toBe("approved");
    expect(rec?.rounds).toHaveLength(2);
    expect(rec?.rounds[0]?.reviewerApproved).toBe(false);
    expect(rec?.rounds[0]?.deviations.length).toBeGreaterThan(0);
    expect(rec?.rounds[0]?.fixRan).toBe(true);
    expect(rec?.rounds[0]?.fixOutcome?.success).toBe(true);
    expect(rec?.rounds[0]?.fixOutcome?.summary).toContain("applied the fix");
    // No raw diff anywhere in the persisted record.
    expect(JSON.stringify(rec)).not.toContain("diff --git");
    expect(rec?.rounds[1]?.reviewerApproved).toBe(true);
    expect(rec?.rounds[1]?.fixRan).toBe(false);
  });

  it("no-progress stop: same deviations survive a fix round, residual deviations recorded", async () => {
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("plan-adherence review")) {
        return {
          success: true,
          output: '{"adherent": false, "deviations": ["still the wrong warning text"]}',
        };
      }
      return { success: true, output: "tried, but did not change the flagged code" };
    });

    await runOneSprint(runIsolatedTask);

    const rec = readRecord();
    expect(rec?.finalVerdict).toBe(false);
    expect(rec?.stopReason).toBe("no_progress");
    expect(rec?.residualDeviations).toContain("still the wrong warning text");
    expect(rec?.rounds).toHaveLength(2);
    expect(rec?.rounds[0]?.fixRan).toBe(true);
    expect(rec?.rounds[1]?.reviewerApproved).toBe(false);
    expect(rec?.rounds[1]?.fixRan).toBe(false);
  });

  it("a >400-char deviation is bounded in the persisted record but kept full in nextFocus", async () => {
    // 611 chars, no leading/trailing whitespace (the review's `normalizeDeviations`
    // trims each string) — comfortably over the 400-char persisted-record bound.
    const LONG_DEVIATION = "still-the-wrong-warning-text-needs-a-real-fix-".repeat(13);
    expect(LONG_DEVIATION.length).toBeGreaterThan(400);

    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("plan-adherence review")) {
        return { success: true, output: JSON.stringify({ adherent: false, deviations: [LONG_DEVIATION] }) };
      }
      return { success: true, output: "tried, but did not change the flagged code" };
    });
    // Done-gate must FAIL so sprint-runner's Step 9 actually sets `nextFocus`
    // from the raw (unbounded) `verdict.deviations` — otherwise that path
    // never runs and the test would prove nothing about it.
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (evaluateDoneGate as any).mockResolvedValue({ pass: false, score: 0.1 });

    const iter = await runOneSprintCapture(runIsolatedTask);

    const rec = readRecord();
    expect(rec?.stopReason).toBe("no_progress");
    expect(rec?.residualDeviations).toHaveLength(1);
    // Persisted copy is bounded (400 chars + the "…" truncation marker).
    expect(rec?.residualDeviations[0]?.length).toBeLessThanOrEqual(401);
    expect(rec?.residualDeviations[0]).not.toBe(LONG_DEVIATION);
    expect(rec?.residualDeviations[0]?.endsWith("…")).toBe(true);

    // nextFocus (what actually drives next-sprint behaviour) keeps the FULL,
    // un-bounded deviation text — the persisted-record bound must not leak
    // into control flow.
    expect(iter.nextFocus).toContain(LONG_DEVIATION);
  });

  it("disabled via MUONROI_IDEAL_ADHERENCE_REVIEW=0: no review call, record still written", async () => {
    process.env.MUONROI_IDEAL_ADHERENCE_REVIEW = "0";
    const runIsolatedTask = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: "{}" }));

    await runOneSprint(runIsolatedTask);

    expect(runIsolatedTask).not.toHaveBeenCalled();
    const rec = readRecord();
    expect(rec).not.toBeNull();
    expect(rec?.enabled).toBe(false);
    expect(rec?.finalVerdict).toBe(true);
    expect(rec?.stopReason).toBe("disabled");
    expect(rec?.rounds).toEqual([]);
    expect(rec?.residualDeviations).toEqual([]);
  });
});

describe("plan-adherence artifact — the review throws before producing a verdict", () => {
  // Mirrors sprint-runner.ts's own Step 4c try/catch exactly: `yield*
  // runPlanAdherenceReview(...)` inside a try, `buildErrorAdherenceRecord` +
  // `writeSprintAdherence` in the catch. Exercised directly against the real
  // review generator (via an injectable `diffProvider` that throws) rather
  // than through a full `runSprint`, because every failure mode reachable
  // through `ctx.runIsolatedTask` is already caught INSIDE
  // `runPlanAdherenceReview` and converted into a "no parseable verdict"
  // outcome (see `plan-adherence-review.test.ts`) — it never escapes as a
  // thrown exception, so a full-sprint repro of a genuine throw does not
  // exist in production and would only fake one.
  it("records stopReason error with the exception message, and the file round-trips", async () => {
    const { runPlanAdherenceReview } = await import("../plan-adherence-review.js");
    const { buildErrorAdherenceRecord } = await import("../sprint-runner.js");
    const { writeSprintAdherence, readSprintAdherence } = await import("../../flow/run-artifacts.js");

    const localFlowDir = mkdtempSync(join(tmpdir(), "s2-adherence-error-"));
    try {
      const sprintN = 1;
      const runId = "run-s2-adherence-error";
      const startedAt = new Date().toISOString();
      let record: Awaited<ReturnType<typeof buildErrorAdherenceRecord>>;
      try {
        const gen = runPlanAdherenceReview({
          sprintN,
          planSynthesis: "plan with file_edits",
          cwd: "/tmp",
          reviewModelId: "leader-pro",
          fixModelId: "cheap-flash",
          runIsolatedTask: async () => ({ success: true, output: '{"adherent": true}' }),
          diffProvider: () => {
            throw new Error("diff provider exploded");
          },
        });
        await gen.next();
        throw new Error("expected runPlanAdherenceReview to throw");
      } catch (err) {
        record = buildErrorAdherenceRecord({ sprintN, runId, startedAt, error: err });
      }

      expect(record.stopReason).toBe("error");
      expect(record.enabled).toBe(true);
      expect(record.finalVerdict).toBe(false);
      expect(record.rounds).toEqual([]);
      expect(record.residualDeviations).toEqual([]);
      expect(record.errorMessage).toContain("diff provider exploded");

      const wrote = await writeSprintAdherence(localFlowDir, runId, record);
      expect(wrote).toBe(true);
      const readBack = await readSprintAdherence(localFlowDir, runId, sprintN);
      expect(readBack).toEqual(record);
    } finally {
      rmSync(localFlowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
