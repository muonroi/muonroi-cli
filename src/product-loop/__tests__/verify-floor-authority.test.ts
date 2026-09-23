import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F2 — the deterministic verify floor could veto but never admit.
 *
 * `sprint-runner.ts` only ran the floor when the model had ALREADY claimed
 * PASS, so a sprint whose verify sub-agent emitted no verdict marker at all was
 * scored UNKNOWN and the floor never ran. Measured on run `mttwpmu8ee5b`: the
 * baseline was captured successfully —
 *
 *     [verify-floor] baseline captured for run mttwpmu8ee5b:
 *       buildOk=true, 31 pre-existing test failure(s), unattributable=false
 *
 * — and then never read. Both sprints ended `failedCondition:
 * "engineering_floor"`, `score: 0`, and the run produced nothing.
 *
 * This file pins BOTH halves: the decision function's contract, and the fact
 * that the production call sites actually reach it and carry its verdict
 * onward. The second half matters more — a helper that decides correctly while
 * the real path passes it nothing is exactly the shape this repo has shipped
 * before.
 */

// ── Half 1: the decision function's contract ─────────────────────────────────

import { applyVerifyFloor, type VerifyFloorResult } from "../verify-floor.js";

function floorResult(verdict: VerifyFloorResult["verdict"]): VerifyFloorResult {
  return {
    verdict,
    ...(verdict === "unavailable" ? { unavailableReason: "no-commands-discovered" as const } : {}),
    checks: [],
    commandsDiscovered: { build: [], test: [] },
    elapsedMs: 1,
    detail: `floor ${verdict}`,
    // Coverage is measured, not asserted, and this fixture runs no command — so
    // "not measured", which is null and never 0. `applyVerifyFloor` does not read
    // it; `sprint-runner` does, when merging a measurement into the recipe.
    measuredCoverage: null,
  };
}

describe("applyVerifyFloor — authoritative in both directions, but only where it is entitled to speak", () => {
  it("a clean floor CARRIES a verdict the model left UNKNOWN", () => {
    const applied = applyVerifyFloor("UNKNOWN", floorResult("pass"));
    expect(applied.verdict).toBe("PASS");
    expect(applied.upgraded).toBe(true);
    expect(applied.downgraded).toBe(false);
  });

  it("a clean floor does NOT overturn a model-reported FAIL", () => {
    // UNKNOWN is the ABSENCE of a claim; FAIL is a positive one. The floor's
    // command set cannot see a smoke phase or a runtime crash outside the test
    // runner, so a green build does not disprove "I failed".
    const applied = applyVerifyFloor("FAIL", floorResult("pass"));
    expect(applied.verdict).toBe("FAIL");
    expect(applied.upgraded).toBe(false);
  });

  it("a clean floor does NOT overturn ERROR — the verify harness itself broke", () => {
    const applied = applyVerifyFloor("ERROR", floorResult("pass"));
    expect(applied.verdict).toBe("ERROR");
    expect(applied.upgraded).toBe(false);
  });

  it("a floor that could not run changes NOTHING, in either direction", () => {
    expect(applyVerifyFloor("UNKNOWN", floorResult("unavailable")).verdict).toBe("UNKNOWN");
    expect(applyVerifyFloor("UNKNOWN", floorResult("unavailable")).upgraded).toBe(false);
    expect(applyVerifyFloor("PASS", floorResult("unavailable")).verdict).toBe("PASS");
    expect(applyVerifyFloor("PASS", floorResult("unavailable")).downgraded).toBe(false);
    expect(applyVerifyFloor("FAIL", floorResult("unavailable")).verdict).toBe("FAIL");
  });

  it("still downgrades a claimed PASS the gates contradict (the original guarantee)", () => {
    const applied = applyVerifyFloor("PASS", floorResult("fail"));
    expect(applied.verdict).toBe("FAIL");
    expect(applied.downgraded).toBe(true);
  });

  it("a failing floor leaves a non-PASS verdict where it was", () => {
    expect(applyVerifyFloor("UNKNOWN", floorResult("fail")).verdict).toBe("UNKNOWN");
    expect(applyVerifyFloor("FAIL", floorResult("fail")).verdict).toBe("FAIL");
  });
});

// ── Half 2: the production call sites ────────────────────────────────────────

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
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  recordProductSpend: vi.fn(async () => undefined),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

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
function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "run-authority",
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
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    ...overrides,
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R | undefined> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value as R;
  }
}

/** A real project whose own `typecheck` script exits with the given code. */
function writeProject(typecheckExitCode: number): void {
  writeFileSync(
    join(projectCwd, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { typecheck: `node -e "process.exit(${typecheckExitCode})"` },
    }),
    "utf8",
  );
  writeFileSync(join(projectCwd, "bun.lock"), "", "utf8");
}

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "floor-auth-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "floor-auth-cwd-"));
  vi.clearAllMocks();
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
  // The exact shape of the measured run: the verify sub-agent narrates, but
  // emits NEITHER verdict marker, so parseVerifyResult returns UNKNOWN.
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "I'll run the local verification pass following the mandatory workflow. Let me start by probing…",
    verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
  });
  // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
});

afterEach(() => {
  rmSync(flowDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

describe("sprint-runner call site — the floor is reached on UNKNOWN, not only on PASS", () => {
  it("an UNKNOWN verdict + green project gates ⇒ the sprint's verify result is PASS", async () => {
    writeProject(0);

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(result).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(result!.lastVerifyResult).toBe("PASS");
  }, 90_000);

  it("an UNKNOWN verdict + a red project gate stays non-PASS", async () => {
    writeProject(1);

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).not.toBe("PASS");
  }, 90_000);

  it("a floor that could not run leaves UNKNOWN exactly where it was", async () => {
    // Empty temp dir — no project, so nothing is discoverable to gate on.
    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).toBe("UNKNOWN");
  }, 90_000);

  it("a model-reported FAIL is never upgraded, however green the gates are", async () => {
    writeProject(0);
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "the smoke step never started the app.\nVERIFY_FAIL\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).toBe("FAIL");
  }, 90_000);

  it("still downgrades a claimed PASS the project's own gates contradict", async () => {
    writeProject(1);
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "I ran the tests and everything looks good.\nVERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // biome-ignore lint/style/noNonNullAssertion: runSprint always returns a result
    expect(result!.lastVerifyResult).toBe("FAIL");
  }, 90_000);
});

describe("done-gate call site — the adjudicated verdict has to travel, or the upgrade is inert", () => {
  it("sprint-runner hands the FLOOR-adjudicated verdict to evaluateDoneGate", async () => {
    writeProject(0);

    await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // Without this, done-gate re-parses `lastVerify` — the same marker-less
    // narration that produced UNKNOWN — and scores `engineering_floor` anyway,
    // leaving the floor's upgrade with no effect on the sprint at all.
    expect(evaluateDoneGate).toHaveBeenCalledWith(expect.objectContaining({ verifyVerdict: "PASS" }));
  }, 90_000);
});
