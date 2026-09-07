import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Acceptance test for the deterministic verify floor.
 *
 * The defect this guards: `sprint-runner.ts` derived its verify verdict solely
 * from `parseVerifyResult`, which PASSES as soon as the verify sub-agent's
 * narration contains the literal string `VERIFY_PASS`. No command's exit code
 * was consulted, so a sprint that committed code failing the project's own
 * typecheck was still scored PASS (observed live: commit e750cd10 shipped a
 * TS2722 error and the verify stage passed it).
 *
 * Every mock below mirrors `sprint-runner.test.ts` so the test exercises only
 * sprint-runner orchestration — EXCEPT the verify floor, which is deliberately
 * NOT mocked: it must really shell out and really read an exit code.
 */
vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
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
  reserveForProduct: vi.fn(async () => ({
    id: "tok",
    model: "m",
    provider: "p",
    projected_usd: 0.1,
    est_input_tokens: 100,
    est_output_tokens: 100,
    createdAtMs: Date.now(),
  })),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB1_costProjection, CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
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

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "run-floor",
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

/**
 * Writes a minimal, real Node project whose own `typecheck` script exits with
 * the given code. The floor must DISCOVER this from package.json — the test
 * never tells sprint-runner what command to run.
 */
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
  // Lockfile presence is how `detectPackageManager` picks the runner.
  writeFileSync(join(projectCwd, "bun.lock"), "", "utf8");
}

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "sprint-floor-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "sprint-floor-cwd-"));
  vi.clearAllMocks();
  (CB1_costProjection as any).mockReturnValue({ halt: false, projection: 0, headroom: 100 });
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
  // The verify sub-agent claims success — exactly as it did for the sprint that
  // committed non-compiling code.
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "I ran the tests and everything looks good.\nVERIFY_PASS\n",
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

describe("sprint verify floor", () => {
  it("does NOT reach PASS when the project's own typecheck exits non-zero, even though the verify agent claimed VERIFY_PASS", async () => {
    writeProject(1);

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(result).toBeDefined();
    expect(result!.lastVerifyResult).not.toBe("PASS");
    expect(result!.lastVerifyResult).toBe("FAIL");
  }, 90_000);

  it("still reaches PASS when the project's own gates actually pass", async () => {
    writeProject(0);

    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(result!.lastVerifyResult).toBe("PASS");
  }, 90_000);

  it("leaves the verdict alone when no project is discoverable (floor unavailable, not a manufactured FAIL)", async () => {
    // projectCwd is an empty temp dir — nothing to gate on.
    const result = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(result!.lastVerifyResult).toBe("PASS");
  }, 90_000);
});
