/**
 * sprint-runner-spec-layout-correction.test.ts — S7 reach-the-planner proof.
 *
 * `spec-layout-check.ts` and its unit tests prove the CHECK logic is correct
 * in isolation; `scoping-layout-convention.test.ts` proves the mismatch is
 * persisted at CB-1 scoping time. Neither proves the finding ever reaches the
 * per-sprint planning council — this test proves that last leg, the same way
 * `sprint-runner-layout-convention.test.ts` proves F4b's layout block reaches
 * the same call.
 *
 * Uses real disk I/O for `spec-layout-check.json` (via the production
 * `writeSpecLayoutCheck`/read path) rather than mocking `flow/run-artifacts.js`,
 * so the read side under test is the actual persisted-artifact contract, not a
 * stand-in.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSpecLayoutCheck } from "../../flow/run-artifacts.js";
import type { SpecLayoutCheckResult } from "../spec-layout-check.js";

// All external modules mocked identically to sprint-runner-layout-convention.test.ts.
vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(),
}));
vi.mock("../../verify/orchestrator.js", () => ({
  runVerifyOrchestration: vi.fn(),
}));
vi.mock("../done-gate.js", () => ({
  evaluateDoneGate: vi.fn(),
}));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
}));
vi.mock("../phase-tracker-bridge.js", () => ({
  postSprintBoundary: vi.fn(async () => undefined),
}));
vi.mock("../role-memory.js", () => ({
  appendRoleMemory: vi.fn(async () => undefined),
}));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  recordProductSpend: vi.fn(async () => undefined),
}));
vi.mock("../../providers/runtime.js", () => ({
  detectProviderForModel: vi.fn(() => "anthropic"),
}));
vi.mock("../backlog-store.js", () => ({
  readBacklog: vi.fn(async () => null),
}));
// The repo's own layout scan is a separate concern (F4b) — force it to "no
// convention" so its own block never appears and cannot be confused with the
// S7 correction line under test here.
vi.mock("../layout-convention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout-convention.js")>();
  return { ...actual, scanLayoutConvention: vi.fn().mockResolvedValue(null) };
});

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let testFlowDir = "/tmp/flow";
const runId = "run-test-spec-layout-correction";

function makeCtx(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId,
    flowDir: testFlowDir,
    cwd: "/tmp/repo-under-test",
    idea: "test idea",
    llm: {
      generate: vi.fn(async () => "synthesis text"),
      research: vi.fn(async () => "research"),
    },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({
      testCommands: ["npm test"],
      coverage: 80,
      shellInitCommands: [],
    })),
    ...overrides,
  };
}

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/Acme.CodeStandards",
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

async function drain<T, R>(
  gen: AsyncGenerator<T, R, unknown>,
): Promise<{ chunks: T[]; result: R | undefined; error?: unknown }> {
  const chunks: T[] = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, result: value as R };
      chunks.push(value);
    }
  } catch (error) {
    return { chunks, result: undefined, error };
  }
}

beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-spec-layout-"));
  vi.clearAllMocks();
  (CB3_verifyBlank as ReturnType<typeof vi.fn>).mockReturnValue({ halt: false });
  (evaluateDoneGate as ReturnType<typeof vi.fn>).mockResolvedValue({ pass: true, score: 1.0 });
  (runVerifyOrchestration as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    output: "VERIFY_PASS\n",
    verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
  });
  (runCouncil as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
    yield { type: "content", content: "planning..." };
    return "synthesis text";
  });
});

afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
});

describe("sprint-runner folds the S7 spec-layout correction into the per-sprint planning council's context", () => {
  it("appends a correction line naming the observed root when a mismatch was recorded at scoping", async () => {
    const mismatch: SpecLayoutCheckResult = {
      status: "mismatch",
      findings: [{ path: "src/Acme.CodeStandards", expectedRoot: "src/src", kind: "project" }],
    };
    await writeSpecLayoutCheck(testFlowDir, runId, mismatch);

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(runCouncil).toHaveBeenCalledTimes(1);
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];

    expect(topic).toContain("Correction:");
    expect(topic).toContain("src/Acme.CodeStandards");
    expect(topic).toContain("src/src");
    expect(topic).toMatch(/MUST use the observed root/);

    // Sits alongside the invented folder structure, not instead of it.
    expect(topic).toContain("Folder structure: src/Acme.CodeStandards");
    const folderIdx = topic.indexOf("Folder structure:");
    const correctionIdx = topic.indexOf("Correction:");
    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(correctionIdx).toBeGreaterThan(folderIdx);
  });

  it("adds nothing when the spec-layout check recorded ok — no false correction", async () => {
    await writeSpecLayoutCheck(testFlowDir, runId, { status: "ok", findings: [] });

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];
    expect(topic).not.toContain("Correction:");
  });

  it("adds nothing when no spec-layout-check.json was ever written — absence is not an error", async () => {
    const ctx = makeCtx();
    const { error } = await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(error).toBeUndefined();
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];
    expect(topic).not.toContain("Correction:");
  });
});
