import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The floor only ever ran when the narration was OPTIMISTIC.
 *
 * `sprint-runner.ts` gated the deterministic verify FLOOR on
 * `verifyVerdict === "PASS" || verifyVerdict === "UNKNOWN"`, so a verify
 * sub-agent that emitted `VERIFY_FAIL` skipped it completely — the one direction
 * in which a model's opinion still overrode the measurement built to check it.
 * A pessimistic narration was accepted with NO measurement at all.
 *
 * Measured, run `muc2joffe506` sprint 1 on `qa-platform`
 * (`.muonroi-flow/runs/muc2joffe506/`):
 *
 * - `sprints/1-verify.md` ends in `VERIFY_FAIL` and contains not one floor line
 *   — no `- [build]`, no `- [test]`, no `[verify-floor]`, no `Rule applied`.
 * - That same narration reports, verbatim: "Build ✓, Tests 12/12 ✓, Lint 0
 *   errors ✓", "`npm run verify` passes ✓ (tsc + next build --webpack, exit 0)",
 *   and fails only at "**Phase 3 — App start: PARTIAL**" because "Docker Desktop
 *   process exists but the `docker-desktop` WSL distro is **Stopped**".
 * - `sprints/1-outcome.json`: `{"pass": false, "score": 0, "verify": "FAIL",
 *   "failedCondition": "engineering_floor", "reason": "verify_FAIL",
 *   "criteriaMet": 0, "criteriaUnmet": 4}`.
 * - `sprints/1-verify-fix.json` shows the cost: `failureKeyBefore:
 *   "verify_verdict:FAIL:"` — no floor evidence for the fixer to aim at, and a
 *   600,009ms round that timed out.
 *
 * So the build and the test suite demonstrably passed and the record preserved
 * no measured evidence of it.
 *
 * ## What this file pins
 *
 * 1. The floor's measurement now EXISTS for a model-reported FAIL — and does not
 *    become a PASS. `applyVerifyFloor` already refuses to upgrade a positive
 *    failure claim (`verify-floor-authority.test.ts` pins that contract); this
 *    file pins that the production path reaches the floor at all on that verdict
 *    and preserves what it measured.
 * 2. A genuine regression (the floor's own test command failing) still fails,
 *    with the floor's evidence in the record.
 * 3. The verify-fix-loop interaction, in the direction concluded correct: the
 *    measured case (model FAIL + GREEN floor) still triggers the loop exactly as
 *    before, the newly reachable floor-FAILURE pairs adopt the floor's own
 *    established skips rather than overriding them, and `cur = next` now carries a
 *    FAIL round's floor evidence instead of erasing the previous round's.
 */

import { readSprintOutcomes } from "../../flow/run-artifacts.js";
import { deriveNextAction } from "../next-action.js";
import type { FloorCheckLike, FloorDelta } from "../verify-baseline.js";
import { computeVerifyFixTrigger, runVerifyFixLoop, type VerifyPassOutcome } from "../verify-fix-loop.js";

// ── Fixtures copied from the measured run ─────────────────────────────────────

/**
 * The shape of run muc2joffe506 sprint 1's narration: every code-level gate
 * reported green, the failure on a phase no floor command executes, and the
 * canonical FAIL marker last. Trimmed to the load-bearing lines.
 */
const NARRATION_DOCKER_DOWN = [
  "**Phase 2 — Install, Build, and Test**Frontend deps ✓, Backend venv+requirements ✓.",
  "Build ✓, Tests 12/12 ✓, Lint 0 errors ✓ (5 warnings only).",
  "`npm run verify` passes ✓ (tsc + next build --webpack, exit 0).",
  "Now **Phase 3 — start the app** with Docker Compose:Docker daemon is not running — fallback per recipe: static build verification only.",
  "Docker Desktop process exists but the `docker-desktop` WSL distro is **Stopped**",
  "",
  "## Blockers",
  "",
  "1. **Phase 3 — app start failed: Docker daemon is down.** The `docker-desktop` WSL distro is `Stopped`.",
  "2. **Phase 4 — browser QA could not run: agent-browser is not installed on this host.**",
  "",
  "VERIFY_FAIL",
].join("\n");

/**
 * The same sprint, but with the un-runnable probe's own output surviving into the
 * narration. This string was MEASURED on the Windows host of run muc2joffe506
 * while the verify stage probed for the browser tool its prompt demanded, and is
 * already a `launcher_missing` pattern in `verify-result.ts`
 * (`COULD_NOT_RUN_PATTERNS`) — the record can then name the environment fact
 * instead of blaming the code.
 */
const NARRATION_LAUNCHER_MISSING = [
  "Build ✓, Tests 12/12 ✓, Lint 0 errors ✓.",
  "Phase 4 — browser QA:",
  "which: no agent-browser in (/mingw64/bin:/usr/bin:/c/Users/phila/bin:/c/Windows/system32)",
  "",
  "VERIFY_FAIL",
].join("\n");

function passingFloorDelta(): FloorDelta {
  return {
    verdict: "pass",
    rule: "absolute",
    newlyFailing: [],
    preExisting: [],
    fixed: [],
  } as unknown as FloorDelta;
}

function greenChecks(): FloorCheckLike[] {
  return [
    { kind: "build", command: "cd frontend && npm run build", ok: true, exitCode: 0, timedOut: false },
    { kind: "test", command: "npm run test", ok: true, exitCode: 0, timedOut: false },
  ];
}

// ── 1. The record: what a floor PASS is allowed to MEAN on a model FAIL ───────

describe("deriveNextAction — a green floor under a model-reported FAIL", () => {
  it("names the measurement AND refuses to claim the sprint verified", () => {
    const advice = deriveNextAction({
      sprintN: 1,
      verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
      verifyVerdict: "FAIL",
      floorDelta: passingFloorDelta(),
      floorChecks: greenChecks(),
      verifyOutput: NARRATION_DOCKER_DOWN,
    });

    // The half that used to be lost: the gates were measured, and the message says so.
    expect(advice.action).toMatch(/2 deterministic gate\(s\) PASSED/);
    expect(advice.action).toMatch(/measured/);
    // And the half that must not be overclaimed — the floor does not lift the FAIL.
    expect(advice.action).toMatch(/does not lift/i);
    expect(advice.action).toContain("sprints/1-verify.md");
    // Nothing here identifies a code change, so the message must not assert one.
    expect(advice.locus).toBe("human");
    expect(advice.sprintCanCarryIt).toBe(false);
    // The defect this whole vocabulary replaced.
    expect(advice.action).not.toMatch(/^Retry sprint/);
  });

  it("names the ENVIRONMENT fact when the narration carries a measured could-not-run line", () => {
    const advice = deriveNextAction({
      sprintN: 1,
      verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
      verifyVerdict: "FAIL",
      floorDelta: passingFloorDelta(),
      floorChecks: greenChecks(),
      verifyOutput: NARRATION_LAUNCHER_MISSING,
    });

    expect(advice.locus).toBe("environment");
    expect(advice.action).toContain("which: no agent-browser");
    expect(advice.action).toMatch(/code-level gates are green/);
  });

  it("still prefers the FLOOR's own failure when the floor is the thing that failed", () => {
    const advice = deriveNextAction({
      sprintN: 1,
      verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
      verifyVerdict: "FAIL",
      floorDelta: {
        verdict: "fail",
        failureKind: "test-absolute-no-baseline",
        rule: "absolute",
        newlyFailing: ["tests/api.spec.ts > health"],
        preExisting: [],
        fixed: [],
      } as unknown as FloorDelta,
      floorChecks: [{ kind: "test", command: "npm run test", ok: false, exitCode: 1, timedOut: false }],
      verifyOutput: NARRATION_DOCKER_DOWN,
    });

    // A measured failure outranks the floor-green reconciliation message.
    expect(advice.locus).toBe("code");
    expect(advice.action).toMatch(/Fix what the test gate reported/);
  });
});

// ── 2. The verify-fix-loop interaction ───────────────────────────────────────
//
// Running the floor on a FAIL feeds this loop input pairs it could not previously
// see. Pinned in the direction concluded correct: the MEASURED case (the one that
// motivated the change) still triggers the loop exactly as before, and the newly
// reachable floor-failure pairs adopt the floor's established skips rather than
// overriding them — a fixer round cannot be verified on a red build or through an
// un-runnable gate, and `deriveNextAction` turns the floor's reading into a precise
// action instead.

describe("computeVerifyFixTrigger — the newly reachable floor + model-FAIL pairs", () => {
  const recipe = { testCommands: ["npm test"], coverage: 0.8, shellInitCommands: [] } as never;

  const gateCouldNotRunFloor = {
    verdict: "fail",
    failureKind: "gate-could-not-run",
    rule: "absolute",
    newlyFailing: [],
    preExisting: [],
    fixed: [],
  } as unknown as FloorDelta;

  const preExistingBuildFloor = {
    verdict: "fail",
    failureKind: "build-failed",
    rule: "delta",
    buildAlreadyBroken: true,
    buildAttribution: "pre-existing",
    newlyFailing: [],
    preExisting: [],
    fixed: [],
  } as unknown as FloorDelta;

  it("the MEASURED case — model FAIL with a GREEN floor — still triggers the loop", () => {
    // This is the sprint the whole change is about, and it must behave exactly as
    // it did before: a passing floor is not a skip reason, so the trigger falls
    // through to the verify-verdict branch and the fixer is aimed at the narration.
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: passingFloorDelta(),
      floorChecks: greenChecks() as never,
      recipe,
      verifyOutput: NARRATION_DOCKER_DOWN,
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.failedCondition).toBe("verify_verdict");
  });

  it("a model FAIL plus an un-runnable gate now adopts the floor's skip", () => {
    // Newly reachable. The floor proved no gate could run, so nothing a fixer
    // writes is verifiable this sprint, and `deriveFailureIdentity` would key the
    // round on `gate_could_not_run` — pointing a code fixer at an environment
    // problem it cannot close. The cause carries forward as an environment action.
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: gateCouldNotRunFloor,
      floorChecks: [],
      recipe,
      verifyOutput: NARRATION_DOCKER_DOWN,
    });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBe("not_actionable");

    // …and the skip loses nothing, because the floor's reading becomes the action.
    const advice = deriveNextAction({
      sprintN: 1,
      verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
      verifyVerdict: "FAIL",
      floorDelta: gateCouldNotRunFloor,
      floorChecks: [
        {
          kind: "test",
          command: '"backend/.venv/Scripts/python.exe" -m pytest',
          ok: false,
          exitCode: 1,
          timedOut: false,
          couldNotRun: { kind: "dependency_missing", evidence: "No module named 'pydantic_core._pydantic_core'" },
        },
      ],
      verifyOutput: NARRATION_DOCKER_DOWN,
    });
    expect(advice.locus).toBe("environment");
    expect(advice.action).toContain("No module named 'pydantic_core._pydantic_core'");
  });

  it("a model FAIL plus a pre-existing build break likewise adopts the floor's skip", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: preExistingBuildFloor,
      floorChecks: [],
      recipe,
      verifyOutput: NARRATION_DOCKER_DOWN,
    });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBe("pre_existing_build_only");
  });
});

describe("runVerifyFixLoop — `cur = next` no longer wipes the floor's evidence", () => {
  /**
   * The overwrite a previous slice found: a round whose sub-agent emitted FAIL
   * skipped the floor block entirely, so its `VerifyPassOutcome` carried
   * `floorDelta: undefined` / `floorChecks: undefined`, and `cur = next`
   * (`verify-fix-loop.ts`) replaced a previous round's real evidence — including a
   * cheap re-check's fold — with nothing. With the floor running on every verdict,
   * a FAIL round's outcome is a genuine refresh instead of an erasure.
   *
   * Both halves are driven through the real loop so the assertion is about
   * behaviour, not about a literal this file wrote.
   */
  const initialWithEvidence: VerifyPassOutcome = {
    verifyResult: { success: true, output: NARRATION_DOCKER_DOWN },
    verifyVerdict: "FAIL",
    recipeFromVerify: null,
    floorDelta: passingFloorDelta(),
    floorChecks: greenChecks() as never,
    floorDetail: "Deterministic verify floor PASSED.\n- [build] `initial` → OK (10ms)",
  };

  function passReturning(next: VerifyPassOutcome) {
    // biome-ignore lint/correctness/useYield: stub never needs to yield a StreamChunk
    return async function* (): AsyncGenerator<never, VerifyPassOutcome, unknown> {
      return next;
    };
  }

  async function runLoop(next: VerifyPassOutcome): Promise<VerifyPassOutcome> {
    const gen = runVerifyFixLoop({
      sprintN: 1,
      planSynthesis: "the approved plan",
      openTasks: [],
      fixModelId: "fix-model",
      initial: initialWithEvidence,
      // biome-ignore lint/suspicious/noExplicitAny: generator stub shape
      runVerifyPass: passReturning(next) as any,
      runIsolatedTask: async () => ({ success: true, output: "applied a fix" }),
      maxRounds: 1,
    });
    while (true) {
      const n = await gen.next();
      if (n.done) return n.value.final;
    }
  }

  it("carries the re-verify round's OWN floor evidence into the final outcome", async () => {
    const final = await runLoop({
      verifyResult: { success: true, output: NARRATION_DOCKER_DOWN },
      verifyVerdict: "FAIL",
      recipeFromVerify: null,
      floorDelta: passingFloorDelta(),
      floorChecks: greenChecks() as never,
      floorDetail: "Deterministic verify floor PASSED.\n- [build] `round-1` → OK (11ms)",
    });
    expect(final.floorChecks).toBeDefined();
    expect(final.floorDetail).toContain("`round-1`");
  });

  it("and the OLD shape — a FAIL round with no floor evidence — is exactly the wipe", async () => {
    // Pins WHY this matters: when a round's outcome carries no floor evidence,
    // `cur = next` erases what the previous pass measured. The fix is upstream (the
    // floor now always runs, so the outcome is never evidence-free), not a merge
    // inside this loop — a merge would leave the artifact describing a pass that no
    // longer happened.
    const final = await runLoop({
      verifyResult: { success: true, output: NARRATION_DOCKER_DOWN },
      verifyVerdict: "FAIL",
      recipeFromVerify: null,
    });
    expect(final.floorChecks).toBeUndefined();
    expect(final.floorDetail).toBeUndefined();
  });
});

// ── 3. The production path + the artifacts it leaves ─────────────────────────

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
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

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const RUN_ID = "run-floor-on-fail";

let flowDir: string;
let projectCwd: string;

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
  };
}

// biome-ignore lint/suspicious/noExplicitAny: runSprint takes the full loop ctx shape
function makeCtx(): any {
  return {
    runId: RUN_ID,
    flowDir,
    cwd: projectCwd,
    idea: "test idea",
    llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 0.8, shellInitCommands: [] })),
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R | undefined> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value as R;
  }
}

/**
 * A real project the floor can discover commands from: `bun run typecheck` as the
 * build tier and `bun run test` as the test tier. The test script prints a vitest
 * summary line so `detectNoTestsExecuted` sees a suite that genuinely ran and
 * `detectGateCouldNotRun` sees a gate that genuinely started — the 12/12 of the
 * measured run, reproduced as real exit codes.
 */
function writeProject(opts: { testExitCode: number }): void {
  const testScript =
    opts.testExitCode === 0
      ? "node -e \"console.log('Tests  12 passed (12)'); process.exit(0)\""
      : "node -e \"console.log('Tests  1 failed | 11 passed (12)'); console.log(' FAIL  tests/api.spec.ts > health'); process.exit(1)\"";
  writeFileSync(
    join(projectCwd, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { typecheck: 'node -e "process.exit(0)"', test: testScript },
    }),
    "utf8",
  );
  writeFileSync(join(projectCwd, "bun.lock"), "", "utf8");
}

function readVerifyReport(): string {
  return readFileSync(join(flowDir, "runs", RUN_ID, "sprints", "1-verify.md"), "utf8");
}

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "floor-on-fail-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "floor-on-fail-cwd-"));
  vi.clearAllMocks();
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  // The measured shape: a narration whose every code-level gate reports green,
  // ending in the canonical FAIL marker.
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: NARRATION_DOCKER_DOWN,
    verifyRecipe: { testCommands: ["npm test"], coverage: 0.8, shellInitCommands: [] },
  });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
  // The fix loop would spend a real sub-agent round on this FAIL; the artifacts
  // under test are the FIRST pass's, so it is off for determinism.
  process.env.MUONROI_IDEAL_VERIFY_FIX_ROUNDS = "0";
});

afterEach(() => {
  delete process.env.MUONROI_IDEAL_VERIFY_FIX_ROUNDS;
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("sprint-runner — the floor runs on a model-reported FAIL, and the record keeps both halves", () => {
  it("preserves the floor's MEASURED build+test results while still not claiming the sprint verified", async () => {
    writeProject({ testExitCode: 0 });

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // Half 1 — the measurement EXISTS. Run muc2joffe506's report had none of this.
    const report = readVerifyReport();
    expect(report).toContain("Deterministic verify floor");
    expect(report).toContain("Deterministic verify floor PASSED.");
    expect(report).toMatch(/- \[build\] `bun run typecheck` → OK/);
    expect(report).toMatch(/- \[test\] `bun run test` → OK/);
    expect(report).toContain("Rule applied:");

    // Half 2 — and the sprint is still NOT verified. A green floor does not
    // overturn a positive failure claim about a phase it never executed.
    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).toBe("FAIL");
    expect(report.split("\n")[0]).toContain("FAIL");

    const outcomes = await readSprintOutcomes(flowDir, RUN_ID);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.pass).toBe(false);
    expect(outcome.verify).toBe("FAIL");
    expect(outcome.failedCondition).toBe("engineering_floor");
    expect(outcome.reason).toBe("verify_FAIL");
    // The disagreement is the information, and the record now carries both sides.
    expect(outcome.floorVerdict).toBe("pass");
    // …and names something a reader can act on, which `reason` never did.
    expect(outcome.nextAction).toBeTruthy();
    expect(outcome.nextAction).toMatch(/deterministic gate\(s\) PASSED/);
    expect(outcome.nextAction).not.toMatch(/^Retry sprint/);
    expect(outcome.fixLocus).toBe("human");
    expect(outcome.sprintCanCarryIt).toBe(false);
  }, 120_000);

  it("a GENUINE regression — the floor's own test command failing — still fails, with the floor's evidence", async () => {
    writeProject({ testExitCode: 1 });

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).toBe("FAIL");

    const report = readVerifyReport();
    expect(report).toContain("Deterministic verify floor FAILED");
    expect(report).toMatch(/- \[test\] `bun run test` → EXIT 1/);

    const outcome = (await readSprintOutcomes(flowDir, RUN_ID))[0];
    expect(outcome.pass).toBe(false);
    expect(outcome.verify).toBe("FAIL");
    // The floor's measured failure, not merely the model's claim.
    expect(outcome.floorVerdict).toBe("fail");
    // A measured failure IS a code locus — unlike the green-floor case above.
    expect(outcome.fixLocus).toBe("code");
    expect(outcome.nextAction).not.toMatch(/^Retry sprint/);
  }, 120_000);
});
