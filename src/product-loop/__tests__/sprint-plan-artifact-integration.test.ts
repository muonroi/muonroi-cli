/**
 * S3a — `sprints/<n>-plan.json` wiring through the real `runSprint`.
 *
 * Mirrors the mocking harness `plan-adherence-artifact.test.ts` (S2) already
 * established for this exact seam: mock council/verify/done-gate, drive the
 * real `runSprint` generator, then inspect what actually landed on disk.
 *
 * Two things this slice must prove that a pure builder unit test cannot:
 *   1. `sprint-plan.json`'s placeholder goal (written by `markSprintStarted`,
 *      which runs BEFORE the plan is known) gets replaced by the real goal
 *      once the plan artifact exists — this is `sprint-tracking.ts` +
 *      `sprint-runner.ts` + `sprint-store.ts` working together, not just one
 *      pure function.
 *   2. The implementation turn's prompt is UNCHANGED by this slice — S3a is
 *      observability/structure only; S3b is what will make the impl turn
 *      consume `sprints/<n>-plan.json`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { readSprintPlanArtifact, writeSprintPlanArtifact } from "../../flow/run-artifacts.js";
import { loadCatalog } from "../../models/registry.js";
import { buildSprintPlanArtifact, buildTaskChecklistBlock, computePlanHash } from "../sprint-plan-artifact.js";

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
  updateCriteria: vi.fn(async () => undefined),
}));
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
    detail: "held unavailable by the S3a fixture",
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
// Adherence review is a whole separate turn this slice does not touch — hold it
// disabled so runOneSprint stays focused on the plan-artifact + impl-prompt seam.
process.env.MUONROI_IDEAL_ADHERENCE_REVIEW = "0";

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { planQualityIssues } from "../criteria-seed.js";
import { evaluateDoneGate } from "../done-gate.js";
import { IMPL_EXECUTION_DIRECTIVE, runSprint } from "../sprint-runner.js";
import { readSprintPlan } from "../sprint-store.js";
import { markSprintStarted } from "../sprint-tracking.js";
import type { IterationState, ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const RUN_ID = "run-s3a-goal-flow";

// A structured, synthetic plan (neutral naming) shaped like a real full-path
// council synthesis: JSON block (summary + acceptance_criteria + actionItems)
// followed by `---READABLE---` prose. No `file_edits` key — same as the live
// evidence — so `planQualityIssues` legitimately flags it below.
const PLAN_SUMMARY = "Ship the Acme.Widgets analyzer with 3 core rules and a NuGet package.";
const STRUCTURED_PLAN_JSON = JSON.stringify({
  type: "implementation_plan",
  summary: PLAN_SUMMARY,
  acceptance_criteria: ["Visual Studio shows the warning for a violation."],
  actionItems: [
    {
      step: "set up src/Acme.Widgets",
      owner_lens: "Eng",
      time_estimate: "2h",
      depends_on: [],
      acceptance_criteria: "builds",
    },
    {
      step: "implement rule A",
      owner_lens: "Eng",
      time_estimate: "3h",
      depends_on: ["step1"],
      acceptance_criteria: "rule A fires",
    },
  ],
});
const STRUCTURED_PLAN_SYNTHESIS = `${STRUCTURED_PLAN_JSON}\n---READABLE---\n## Agreed Architecture\nPure Roslyn, no runtime dependency.\n`;

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

function seedRepo(): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: projectCwd, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "s3a@test.local"]);
  run(["config", "user.name", "S3a fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectCwd, "analyzer.cs"), "// before\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
}

let capturedImplPrompt: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test driver context stand-in
function makeCtx(): any {
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
    processMessageFn: vi.fn(async function* (prompt: string) {
      capturedImplPrompt = prompt;
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: [], coverage: 80, shellInitCommands: [] })),
  };
}

async function runOneSprint(): Promise<IterationState> {
  const gen = runSprint({
    sprintN: 1,
    ctx: makeCtx(),
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
  flowDir = mkdtempSync(join(tmpdir(), "s3a-goal-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "s3a-goal-flow-cwd-"));
  seedRepo();
  capturedImplPrompt = undefined;
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
    return STRUCTURED_PLAN_SYNTHESIS;
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
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("sprints/<n>-plan.json — real runSprint wiring", () => {
  it("writes a structured plan artifact for sprint 1", async () => {
    await runOneSprint();

    const artifact = await readSprintPlanArtifact(flowDir, RUN_ID, 1);
    expect(artifact).not.toBeNull();
    expect(artifact?.source).toBe("structured");
    expect(artifact?.sprintN).toBe(1);
    expect(artifact?.runId).toBe(RUN_ID);
    expect(artifact?.outcome.goal).toBe(PLAN_SUMMARY);
    expect(artifact?.tasks.map((t) => t.id)).toEqual(["step1", "step2"]);
    expect(artifact?.tasks[1]?.dependsOn).toEqual(["step1"]);

    // Same shape a resumed sprint would read back.
    const path = join(flowDir, "runs", RUN_ID, "sprints", "1-plan.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).outcome.goal).toBe(PLAN_SUMMARY);
  });

  it("rebuilds a persisted plan artifact whose planHash no longer matches the current planSynthesis", async () => {
    // Seed a STALE artifact — built from different text than the mocked
    // council will return this run, e.g. left over from a retried
    // non-deterministic planning council. Distinguishable content (goal,
    // task ids) so a rebuild vs. a stale-read is unambiguous.
    const staleSynthesis = "a completely different plan from an earlier attempt";
    const staleArtifact = buildSprintPlanArtifact({
      sprintN: 1,
      runId: RUN_ID,
      planSynthesis: staleSynthesis,
    });
    expect(staleArtifact.planHash).toBe(computePlanHash(staleSynthesis));
    await writeSprintPlanArtifact(flowDir, RUN_ID, staleArtifact);

    await runOneSprint();

    const artifact = await readSprintPlanArtifact(flowDir, RUN_ID, 1);
    expect(artifact).not.toBeNull();
    // Rebuilt from the CURRENT planSynthesis, not the stale one.
    expect(artifact?.planHash).toBe(computePlanHash(STRUCTURED_PLAN_SYNTHESIS));
    expect(artifact?.planHash).not.toBe(staleArtifact.planHash);
    expect(artifact?.source).toBe("structured");
    expect(artifact?.outcome.goal).toBe(PLAN_SUMMARY);
    expect(artifact?.tasks.map((t) => t.id)).toEqual(["step1", "step2"]);
  });

  it("reuses a persisted plan artifact whose planHash still matches — no rebuild", async () => {
    // First run persists the real artifact for this planSynthesis.
    await runOneSprint();
    const first = await readSprintPlanArtifact(flowDir, RUN_ID, 1);
    expect(first).not.toBeNull();

    // A second run with the SAME mocked planSynthesis must reuse — not
    // rebuild — the persisted artifact (matches the pre-existing "resumed
    // sprint reuses the persisted plan" contract; hash equality is why).
    await runOneSprint();
    const second = await readSprintPlanArtifact(flowDir, RUN_ID, 1);
    expect(second).toEqual(first);
  });

  it("replaces sprint-plan.json's S1 placeholder goal with the plan's real goal", async () => {
    // Seed exactly what runSprintTracked's markSprintStarted writes BEFORE any
    // plan exists — the placeholder this slice must overwrite.
    await markSprintStarted(flowDir, RUN_ID, 1);
    const before = await readSprintPlan(flowDir, RUN_ID);
    expect(before?.sprints[0]?.goal).toContain("goal not recorded");

    await runOneSprint();

    const after = await readSprintPlan(flowDir, RUN_ID);
    expect(after?.sprints[0]?.goal).toBe(PLAN_SUMMARY);
    // markSprintStarted's other fields (status/startedAtUtc) must survive the
    // goal-only upsert untouched — upsertSprint merges by field.
    expect(after?.sprints[0]?.status).toBe("active");
    expect(after?.sprints[0]?.startedAtUtc).toBe(before?.sprints[0]?.startedAtUtc);
  });

  // S3b note: this plan (STRUCTURED_PLAN_SYNTHESIS) HAS tasks (source
  // "structured", step1+step2 — see the first test in this describe block),
  // so S3b's task checklist is appended to the implementation prompt. This
  // test is therefore no longer "byte-identical to the pre-S3b prompt" — it
  // is updated to assert byte-identical EXCEPT for that one deterministic
  // addition, built via the exact same `buildTaskChecklistBlock` the
  // implementation calls. The genuinely byte-identical case (no tasks,
  // `source: "none"`) moved to its own test right below, which still proves
  // S3b makes NO change at all when a plan carries no tasks.
  it("appends the S3b task checklist to the implementation prompt, after everything else, in topological order", async () => {
    await runOneSprint();

    expect(capturedImplPrompt).toBeDefined();
    expect(capturedImplPrompt!.startsWith(IMPL_EXECUTION_DIRECTIVE)).toBe(true);

    // The prompt is IMPL_EXECUTION_DIRECTIVE + the untouched planSynthesis text
    // + planQualityIssues' own note (computed independently, via the SAME
    // unmodified function sprint-runner.ts calls) — S3a only READS
    // planSynthesis to build sprints/<n>-plan.json, it never mutates the
    // variables that compose this prompt.
    const seededCriteria = ["Visual Studio shows the warning for a violation."];
    const issues = planQualityIssues(STRUCTURED_PLAN_SYNTHESIS, seededCriteria.length);
    const expectedNote =
      issues.length > 0
        ? `\n\n--- PLAN QUALITY WARNINGS (address these while implementing) ---\n${issues
            .map((i) => `- ${i}`)
            .join(
              "\n",
            )}\nImplement to satisfy the phase goal and every acceptance criterion; do not stop at scaffolding.\n`
        : "";
    // The checklist itself, built from the SAME artifact this slice persists
    // (same planSynthesis, no side-channel structuredActionItems — the mocked
    // runCouncil here never populates CouncilStats).
    const artifactForChecklist = buildSprintPlanArtifact({
      sprintN: 1,
      runId: RUN_ID,
      planSynthesis: STRUCTURED_PLAN_SYNTHESIS,
    });
    const { block: expectedChecklistBlock } = buildTaskChecklistBlock(artifactForChecklist.tasks);
    expect(expectedChecklistBlock).not.toBe(""); // this plan DOES have tasks

    const expectedPrompt = IMPL_EXECUTION_DIRECTIVE + STRUCTURED_PLAN_SYNTHESIS + expectedNote + expectedChecklistBlock;
    expect(capturedImplPrompt).toBe(expectedPrompt);
  });

  it("source: none (no tasks) leaves the implementation prompt byte-identical to before S3b — no checklist appended", async () => {
    // A plan with no JSON header and no bullet lines: buildSprintPlanArtifact
    // gives `source: "none"`, `tasks: []` (see sprint-plan-artifact.test.ts's
    // own "empty input gives none" case for the pure-builder proof of this).
    const NONE_PLAN_SYNTHESIS = "Just implement the fix directly in the analyzer. No further breakdown needed.";
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runCouncil as any).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return NONE_PLAN_SYNTHESIS;
    });

    await runOneSprint();

    expect(capturedImplPrompt).toBeDefined();
    const artifact = await readSprintPlanArtifact(flowDir, RUN_ID, 1);
    expect(artifact?.source).toBe("none");
    expect(artifact?.tasks).toEqual([]);

    const issues = planQualityIssues(NONE_PLAN_SYNTHESIS, 0);
    const expectedNote =
      issues.length > 0
        ? `\n\n--- PLAN QUALITY WARNINGS (address these while implementing) ---\n${issues
            .map((i) => `- ${i}`)
            .join(
              "\n",
            )}\nImplement to satisfy the phase goal and every acceptance criterion; do not stop at scaffolding.\n`
        : "";
    const expectedPrompt = IMPL_EXECUTION_DIRECTIVE + NONE_PLAN_SYNTHESIS + expectedNote;
    expect(capturedImplPrompt).toBe(expectedPrompt);
  });
});
