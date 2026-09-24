/**
 * F5 — "the gate never ran" must not be silent either.
 *
 * The goal-contradiction gate writes `sprints/<N>-goal-gate.json` for EVERY
 * outcome it produces, including the ones that change nothing — its own design
 * principle is that "found nothing" and "never ran" must never look alike.
 *
 * But the whole block sits inside `if (verifyVerdict === "PASS")`, so when
 * verify does NOT pass, nothing at all is recorded. MEASURED: across four real
 * runs of the same task, verify never once reached PASS (see
 * `verify-budget-scaling.test.ts` for the durations that caused it), so that was
 * EVERY sprint of EVERY run — and that the gate had been skipped had to be
 * inferred from `<N>-outcome.json`.
 *
 * This pins that the skip is recorded, in the SAME shape and through the SAME
 * writer, naming the verdict that caused it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

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
// Held "unavailable" so no real toolchain is shelled out, and so the verdict
// under test can only have come from the stubbed verify orchestration.
vi.mock("../verify-floor.js", () => ({
  // The shape `runVerifyFloor` really returns for an unavailable verdict
  // (verify-floor.ts:842-857): `unavailableReason` — not `reason` — plus the
  // `commandsDiscovered` and `measuredCoverage` fields sprint-runner reads off
  // every result. The old stand-in omitted both, so `measuredCoverage` read
  // `undefined !== null` and stamped the recipe `coverageSource: "measured"`
  // with no figure behind it.
  runVerifyFloor: vi.fn(async () => ({
    verdict: "unavailable",
    unavailableReason: "no-commands-discovered",
    detail: "held unavailable by the skip-record fixture",
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
import { GOAL_GATE_SYSTEM, type GoalGateRecord } from "../goal-contradiction-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const RUN_ID = "run-f5-skip";

let flowDir: string;
let projectCwd: string;

const ALIGNED = `\`\`\`goal-check\n${JSON.stringify({ verdict: "aligned", contradictions: [], rationale: "ok" })}\n\`\`\`\n`;

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

// biome-ignore lint/suspicious/noExplicitAny: test driver context stand-in
function makeCtx(): any {
  return {
    runId: RUN_ID,
    flowDir,
    cwd: projectCwd,
    idea: "make the analyzer warn in Visual Studio",
    sessionModelId: getTestModels().balanced,
    llm: {
      generate: vi.fn(async (_model: string, system: string) => (system === GOAL_GATE_SYSTEM ? ALIGNED : "synthesis")),
      research: vi.fn(async () => "research"),
    },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: [], coverage: 80, shellInitCommands: [] })),
  };
}

/**
 * A real repository with one committed file and one uncommitted change, so the
 * gate on the PASS path has an actual diff to judge (without one it reports
 * `diff-unreadable` and never reaches a verdict).
 */
function seedRepo(): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: projectCwd, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "f5@test.local"]);
  run(["config", "user.name", "F5 fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectCwd, "analyzer.cs"), "// before\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  writeFileSync(join(projectCwd, "analyzer.cs"), "// before\n// the change under judgement\n", "utf8");
}

/** The gate's durable record, read back the way an auditor would. */
function readRecord(sprintN = 1): GoalGateRecord | null {
  const p = join(flowDir, "runs", RUN_ID, "sprints", `${sprintN}-goal-gate.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as GoalGateRecord;
}

async function runOneSprint(): Promise<void> {
  const gen = runSprint({
    sprintN: 1,
    ctx: makeCtx(),
    productSpec: makeSpec(),
    roleAssignments: NO_ROLES,
    history: [],
  });
  while (true) {
    const { done } = await gen.next();
    if (done) return;
  }
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "f5-skip-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "f5-skip-cwd-"));
  seedRepo();
  vi.clearAllMocks();
  process.env.MUONROI_SPRINT_SELF_VERIFY = "0";
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
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
});

afterEach(() => {
  delete process.env.MUONROI_SPRINT_SELF_VERIFY;
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("goal gate — a skipped gate is recorded, not inferred", () => {
  it("records the skip when verify FAILs, naming the verdict that caused it", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockResolvedValue({
      success: false,
      output: "VERIFY_FAIL\nthe build is red\n",
      verifyRecipe: { testCommands: [], coverage: 80, shellInitCommands: [] },
    });

    await runOneSprint();

    const rec = readRecord();
    expect(rec).not.toBeNull();
    expect(rec?.source).toBe("verdict-not-pass");
    expect(rec?.fired).toBe(false);
    expect(rec?.verifyVerdict).toBe("FAIL");
    expect(rec?.sprintN).toBe(1);
    expect(rec?.runId).toBe(RUN_ID);
    expect(rec?.detail).toContain("FAIL");
  });

  it("records the skip when verify ERRORs — the mtw9mpjt1ce3 watchdog case", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockResolvedValue({
      success: false,
      output: "",
      error: "verify-timeout: verify stage exceeded its budget",
      verifyRecipe: { testCommands: [], coverage: 80, shellInitCommands: [] },
    });

    await runOneSprint();

    const rec = readRecord();
    expect(rec?.source).toBe("verdict-not-pass");
    expect(rec?.verifyVerdict).toBe("ERROR");
    expect(rec?.detail).toContain("ERROR");
  });

  it("leaves the PASS path's record exactly as it was", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "Everything looks good.\nVERIFY_PASS\n",
      verifyRecipe: { testCommands: [], coverage: 80, shellInitCommands: [] },
    });

    await runOneSprint();

    const rec = readRecord();
    expect(rec?.source).toBe("aligned");
    expect(rec?.fired).toBe(false);
    // The PASS path never sets this field — it is the skip's marker alone.
    expect(rec?.verifyVerdict).toBeUndefined();
  });
});
