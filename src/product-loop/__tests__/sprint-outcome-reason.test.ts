/**
 * F9 — a verdict must carry its reason.
 *
 * `evaluateDoneGate` computes a precise cause for an engineering-floor failure
 * (`no_recipe` | `no_test_commands` | `zero_coverage` | `verify_FAIL`), returns
 * it on `DoneVerdict.reason` — and the persisted sprint outcome threw it away:
 *
 *   {"sprintN":1,"pass":false,"score":0,"verify":"PASS",
 *    "failedCondition":"engineering_floor","criteriaMet":0,…}
 *
 * `verify: "PASS"` with `failedCondition: "engineering_floor"` narrows the cause
 * to three possibilities and names none. The reason survived nowhere else — not
 * in the artifacts, not in the DB, not in the logs — so the run was
 * undiagnosable after the fact.
 *
 * These tests pin the whole chain: the record on disk, the REAL `runSprint`
 * call site that writes it, and every surface that already shows
 * `failedCondition`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { readSprintOutcomes, type SprintOutcome, sprintsDir, writeSprintOutcome } from "../../flow/run-artifacts.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { buildContinueFeedback } from "../feedback-routing.js";
import { deriveRunVerdict, describeVerdictFailure } from "../run-verdict.js";
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

function makeCtx(): any {
  return {
    runId: "run-f9",
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
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R | undefined }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

function outcomeOnDisk(sprintN: number): SprintOutcome {
  return JSON.parse(readFileSync(join(sprintsDir(flowDir, "run-f9"), `${sprintN}-outcome.json`), "utf8"));
}

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "f9-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "f9-cwd-"));
  vi.clearAllMocks();
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "VERIFY_PASS\n",
    verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
  });
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
});

afterEach(() => {
  rmSync(flowDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

describe("F9 — the sprint outcome records WHY the floor failed (real runSprint)", () => {
  it("persists the engineering-floor reason the done-gate computed", async () => {
    // Exactly today's shape: verify PASS, floor failed — three possible causes.
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "no_test_commands",
      score: 0,
    });

    await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const outcome = outcomeOnDisk(1);
    expect(outcome.failedCondition).toBe("engineering_floor");
    expect(outcome.reason).toBe("no_test_commands");
  }, 90_000);

  it("persists the reason for a NON-floor condition too", async () => {
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "weighted_score",
      reason: "score_below_threshold: 0.40 < 0.9",
      score: 0.4,
    });

    await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(outcomeOnDisk(1).reason).toBe("score_below_threshold: 0.40 < 0.9");
  }, 90_000);

  it("names the cause to the user instead of the bare condition", async () => {
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "zero_coverage",
      score: 0,
    });

    const { chunks } = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const text = (chunks as any[]).map((c) => c.content ?? "").join("");
    expect(text).toContain("did not satisfy Definition-of-Done (engineering_floor: zero_coverage)");
  }, 90_000);

  it("leaves `reason` absent when the verdict genuinely had none", async () => {
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1 });

    await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(outcomeOnDisk(1).reason).toBeUndefined();
  }, 90_000);
});

describe("F9 — the reason reaches the surfaces that already show the condition", () => {
  it("survives a write/read round-trip through the run artifacts", async () => {
    await writeSprintOutcome(flowDir, "round-trip", {
      sprintN: 1,
      pass: false,
      score: 0,
      verify: "PASS",
      failedCondition: "engineering_floor",
      reason: "no_recipe",
      criteriaMet: 0,
      criteriaPartial: 0,
      criteriaUnmet: 2,
      finishedAt: "2026-09-10T03:04:31.000Z",
    });
    const [read] = await readSprintOutcomes(flowDir, "round-trip");
    expect(read?.reason).toBe("no_recipe");
  });

  it("describeVerdictFailure pairs the condition with its cause", () => {
    expect(describeVerdictFailure({ failedCondition: "engineering_floor", reason: "verify_FAIL" })).toBe(
      "engineering_floor: verify_FAIL",
    );
    // No reason recorded (a pre-F9 outcome read back off disk) — unchanged.
    expect(describeVerdictFailure({ failedCondition: "engineering_floor" })).toBe("engineering_floor");
    // Reason only, no condition.
    expect(describeVerdictFailure({ reason: "no_sprint_outcomes" })).toBe("no_sprint_outcomes");
    // Nothing at all is `undefined`, so callers keep their own wording.
    expect(describeVerdictFailure({})).toBeUndefined();
    // A reason that merely repeats the condition is not printed twice.
    expect(describeVerdictFailure({ failedCondition: "user_approval", reason: "user_approval" })).toBe("user_approval");
  });

  it("the run-level verdict carries the cause, not just the condition", () => {
    const verdict = deriveRunVerdict({
      phasesPassed: true,
      outcomes: [
        {
          sprintN: 1,
          pass: false,
          score: 0,
          verify: "PASS",
          failedCondition: "engineering_floor",
          reason: "no_test_commands",
          criteriaMet: 0,
          criteriaPartial: 0,
          criteriaUnmet: 2,
          finishedAt: "2026-09-10T03:04:31.000Z",
        },
      ],
    });
    expect(verdict.reason).toBe("sprint_1_failed: engineering_floor: no_test_commands");
    expect(verdict.failedCondition).toBe("engineering_floor");
  });

  it("the next sprint's carry-over names the floor cause the verify log cannot show", () => {
    // `no_test_commands` never appears in verify output — the old focus pasted a
    // log that had nothing to do with why the sprint failed.
    const fb = buildContinueFeedback(
      { pass: false, failedCondition: "engineering_floor", reason: "no_test_commands", score: 0 },
      { success: false, output: "all good" } as any,
      [],
    );
    expect(fb.focus).toContain("no_test_commands");
  });
});
