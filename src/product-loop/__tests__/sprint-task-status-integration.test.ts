/**
 * S3b — the task-aware plan-adherence review wired through the real
 * `runSprint` (Step 4c): reviewer per-task verdicts persisted into
 * `sprints/<n>-plan.json`, the fixer scoped to only the not-done tasks, and
 * unfinished tasks carried into `iter.nextFocus`.
 *
 * Mirrors the mocking harness `plan-adherence-artifact.test.ts` (S2) and
 * `sprint-plan-artifact-integration.test.ts` (S3a) already established for
 * this exact seam: mock council/verify/done-gate, drive the real `runSprint`
 * generator, then inspect what actually landed on disk.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { readSprintAdherence, readSprintPlanArtifact } from "../../flow/run-artifacts.js";
import { loadCatalog } from "../../models/registry.js";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import type { SprintPlanArtifact } from "../sprint-plan-artifact.js";

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
    detail: "held unavailable by the S3b fixture",
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
const RUN_ID = "run-s3b-task-status";

// Two tasks with real targets (src/foo.ts, src/bar.ts) plus one with none (a
// manual verification step — the "no-targets" case).
const PLAN_SUMMARY = "Ship the widget with a manual sign-off step.";
const PLAN_JSON = JSON.stringify({
  summary: PLAN_SUMMARY,
  acceptance_criteria: ["it works"],
  actionItems: [
    {
      step: "create src/foo.ts",
      owner_lens: "Eng",
      time_estimate: "1h",
      depends_on: [],
      acceptance_criteria: "src/foo.ts exists and exports foo",
    },
    {
      step: "create src/bar.ts",
      owner_lens: "Eng",
      time_estimate: "1h",
      depends_on: ["step1"],
      acceptance_criteria: "src/bar.ts exists and exports bar",
    },
    {
      step: "manually verify in the IDE",
      owner_lens: "QA",
      time_estimate: "15m",
      depends_on: ["step2"],
      acceptance_criteria: "confirmed manually, no file to check",
    },
  ],
});
const PLAN_SYNTHESIS = `${PLAN_JSON}\n---READABLE---\n## Agreed Architecture\nTwo small modules plus a manual sign-off.\n`;

let flowDir: string;
let projectCwd: string;

function makeSpec(): ProductSpec {
  return {
    idea: "ship the widget",
    persona: "devs",
    mvp: ["the widget works"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

/**
 * Real repo so `git diff HEAD` (the review's diff source) has something to
 * read: commit README.md, then leave an UNCOMMITTED bump on it so `git diff
 * HEAD` is non-empty by default for every test in this file (the review's
 * own "no diff -> skip entirely" short-circuit is out of scope here — see
 * `plan-adherence-review.test.ts`'s "skips cleanly when there is no diff").
 * Individual tests layer their own src/foo.ts / src/bar.ts changes on top to
 * control per-task `touchedTargets`.
 */
function seedRepo(): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: projectCwd, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "s3b@test.local"]);
  run(["config", "user.name", "S3b fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectCwd, "README.md"), "seed\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  writeFileSync(join(projectCwd, "README.md"), "seed\n// uncommitted bump so git diff HEAD is non-empty\n", "utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: test driver context stand-in
function makeCtx(runIsolatedTask?: (req: TaskRequest) => Promise<ToolResult>): any {
  return {
    runId: RUN_ID,
    flowDir,
    cwd: projectCwd,
    idea: "ship the widget",
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

async function readPlanArtifact(): Promise<SprintPlanArtifact | null> {
  return readSprintPlanArtifact(flowDir, RUN_ID, 1);
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "s3b-task-status-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "s3b-task-status-cwd-"));
  seedRepo();
  vi.clearAllMocks();
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
    return PLAN_SYNTHESIS;
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

describe("task-aware plan-adherence review — sprints/<n>-plan.json statuses", () => {
  it("step1 not done, step2+step3 done: fixer call scoped to step1 only, statuses persisted", async () => {
    let reviewCalls = 0;
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            success: true,
            output: JSON.stringify({
              tasks: [
                { taskId: "step1", done: false, evidence: "src/foo.ts missing", deviation: "file not created" },
                { taskId: "step2", done: true, evidence: "src/bar.ts created as planned" },
                { taskId: "step3", done: true, evidence: "manual sign-off recorded in the transcript" },
              ],
            }),
          };
        }
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              { taskId: "step1", done: true, evidence: "src/foo.ts now exists" },
              { taskId: "step2", done: true, evidence: "src/bar.ts created as planned" },
              { taskId: "step3", done: true, evidence: "manual sign-off recorded in the transcript" },
            ],
          }),
        };
      }
      // Fix call — must be scoped to step1 only.
      expect(req.prompt).toContain("step1");
      expect(req.prompt).not.toContain("[step2]");
      expect(req.prompt).not.toContain("[step3]");
      return { success: true, output: "created src/foo.ts" };
    });

    const iter = await runOneSprintCapture(runIsolatedTask);
    expect(iter).toBeDefined();

    const fixCalls = runIsolatedTask.mock.calls
      .map((c) => c[0] as TaskRequest)
      .filter((r) => r.description.includes("fix"));
    expect(fixCalls).toHaveLength(1);

    const artifact = await readPlanArtifact();
    expect(artifact).not.toBeNull();
    const byId = new Map(artifact!.tasks.map((t) => [t.id, t]));
    expect(byId.get("step1")?.status).toBe("done");
    expect(byId.get("step2")?.status).toBe("done");
    expect(byId.get("step3")?.status).toBe("done");
  });

  it("unparseable reviewer output: no task marked done, statuses stay pending", async () => {
    process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS = "1";
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return { success: true, output: "Looks fine to me, no structured output here." };
      }
      return { success: true, output: "n/a" };
    });

    await runOneSprintCapture(runIsolatedTask);

    const artifact = await readPlanArtifact();
    expect(artifact).not.toBeNull();
    expect(artifact!.tasks.every((t) => t.status === "pending")).toBe(true);
  });

  it("a task marked done whose declared targets were NOT touched gets a note; a no-targets task gives touchedTargets null", async () => {
    // Diff touches only README.md — never src/foo.ts or src/bar.ts — yet the
    // reviewer (hallucinating) marks step1 done. This is exactly the safety
    // net S3b adds: diff-touch is supplementary evidence, not proof, but a
    // mismatch between "reviewer says done" and "targets untouched" must be
    // visible, not silently accepted.
    writeFileSync(join(projectCwd, "README.md"), "seed\n// bump, but no src/ changes\n", "utf8");

    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              { taskId: "step1", done: true, evidence: "reviewer believes it's done" },
              { taskId: "step2", done: true, evidence: "reviewer believes it's done" },
              { taskId: "step3", done: true, evidence: "manual sign-off recorded" },
            ],
          }),
        };
      }
      return { success: true, output: "n/a" };
    });

    await runOneSprintCapture(runIsolatedTask);

    const artifact = await readPlanArtifact();
    expect(artifact).not.toBeNull();
    const byId = new Map(artifact!.tasks.map((t) => [t.id, t]));

    // step1/step2 declared targets (src/foo.ts, src/bar.ts); neither was
    // touched by the diff, so both are flagged despite being marked "done".
    expect(byId.get("step1")?.touchedTargets).toBe(false);
    expect(byId.get("step2")?.touchedTargets).toBe(false);
    expect(artifact!.notes.some((n) => n.includes("step1") && n.toLowerCase().includes("not touched"))).toBe(true);
    expect(artifact!.notes.some((n) => n.includes("step2") && n.toLowerCase().includes("not touched"))).toBe(true);

    // step3 ("manually verify in the IDE") names no target at all.
    expect(byId.get("step3")?.targetFiles).toEqual([]);
    expect(byId.get("step3")?.targetDirs).toEqual([]);
    expect(byId.get("step3")?.touchedTargets).toBeNull();
    expect(artifact!.notes.some((n) => n.includes("step3"))).toBe(false);
  });

  it("unfinished sprint tasks are carried into iter.nextFocus", async () => {
    process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS = "1";
    // Done-gate must FAIL so Step 9 actually sets nextFocus.
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (evaluateDoneGate as any).mockResolvedValue({ pass: false, score: 0.2 });

    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              { taskId: "step1", done: true, evidence: "done" },
              { taskId: "step2", done: false, evidence: "not started", deviation: "src/bar.ts missing" },
              { taskId: "step3", done: false, evidence: "not confirmed" },
            ],
          }),
        };
      }
      return { success: true, output: "n/a" };
    });

    const iter = await runOneSprintCapture(runIsolatedTask);

    expect(iter.nextFocus).toBeDefined();
    expect(iter.nextFocus).toContain("[step2]");
    expect(iter.nextFocus).toContain("create src/bar.ts");
    expect(iter.nextFocus).toContain("[step3]");
    expect(iter.nextFocus).toContain("manually verify in the IDE");
    expect(iter.nextFocus).not.toContain("[step1]");
  });

  // BLOCKER regression, full runSprint (acceptance rejection, run
  // mu229bfiaeec): a general deviation (e.g. a silently redefined rule)
  // reported alongside every task done must survive into the PERSISTED
  // adherence record and into next sprint's focus — not just the in-memory
  // verdict already covered by plan-adherence-review-tasks.test.ts.
  it("a general deviation with all tasks done survives into sprints/<n>-adherence.json AND iter.nextFocus", async () => {
    process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS = "2";
    // Done-gate must FAIL so Step 9 actually sets nextFocus.
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (evaluateDoneGate as any).mockResolvedValue({ pass: false, score: 0.4 });

    const GENERAL_DEVIATION = "an unplanned rule severity change, outside the approved plan";
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({
            adherent: false,
            deviations: [GENERAL_DEVIATION],
            tasks: [
              { taskId: "step1", done: true, evidence: "done" },
              { taskId: "step2", done: true, evidence: "done" },
              { taskId: "step3", done: true, evidence: "done" },
            ],
          }),
        };
      }
      return { success: true, output: "the deviation is not addressed by this fix" };
    });

    const iter = await runOneSprintCapture(runIsolatedTask);

    // Never silently "approved" despite every task being done.
    const record = await readSprintAdherence(flowDir, RUN_ID, 1);
    expect(record).not.toBeNull();
    expect(record?.finalVerdict).toBe(false);
    expect(record?.stopReason).not.toBe("approved");
    expect(record?.residualDeviations).toContain(GENERAL_DEVIATION);

    // The persisted plan artifact still shows every task done — the blocker
    // was about the DEVIATION vanishing, not about tasks being mis-marked.
    const artifact = await readPlanArtifact();
    expect(artifact?.tasks.every((t) => t.status === "done")).toBe(true);

    // Carried into next sprint's focus alongside (not instead of) task info.
    expect(iter.nextFocus).toContain(GENERAL_DEVIATION);
  });
});

describe("task-aware plan-adherence review — write failure is logged, sprint continues", () => {
  it("a persist failure after the review does not throw and the sprint still completes", async () => {
    const runArtifacts = await import("../../flow/run-artifacts.js");
    const writeSpy = vi.spyOn(runArtifacts, "writeSprintPlanArtifact").mockImplementation(async () => false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              { taskId: "step1", done: true, evidence: "done" },
              { taskId: "step2", done: true, evidence: "done" },
              { taskId: "step3", done: true, evidence: "done" },
            ],
          }),
        };
      }
      return { success: true, output: "n/a" };
    });

    let iter: IterationState | undefined;
    await expect(
      (async () => {
        iter = await runOneSprintCapture(runIsolatedTask);
      })(),
    ).resolves.not.toThrow();

    expect(iter).toBeDefined();
    expect(writeSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not persist task-verdict statuses"));

    writeSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
