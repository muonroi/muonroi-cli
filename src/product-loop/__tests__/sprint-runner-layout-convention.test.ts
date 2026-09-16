/**
 * sprint-runner-layout-convention.test.ts — F4b reach-the-planner proof.
 *
 * The layout-convention module (layout-convention.ts) and its unit tests
 * (layout-convention.test.ts) prove the EXTRACTION logic is correct in
 * isolation. Neither proves the result ever reaches the model call that plans
 * a sprint — sprint-runner.ts wires `scanLayoutConvention` into `councilTopic`
 * at the "Plan stage (council, skipClarification=true)" step (the per-sprint
 * planner: its `runCouncil` call carries `sprintPlanningMode: true` and its
 * return value becomes `planSynthesis`, which drives the Implementation stage
 * next). This test proves that wiring by mocking `scanLayoutConvention` and
 * inspecting the literal string handed to `runCouncil` — the same technique
 * `sprint-runner-backlog.test.ts` uses to prove the backlog anchor reaches the
 * same call.
 *
 * A repo with NO dominant layout (the common case: greenfield, or a flat
 * project) must reach the planner with NOTHING added — the report-only
 * contract (constraint 2 of F4b) has to hold at the call site, not just
 * inside deriveLayoutConvention's unit tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All external modules mocked identically to sprint-runner-backlog.test.ts.
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
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
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

// The module under proof: mock ONLY `scanLayoutConvention` (the filesystem
// walk) and keep the real `formatLayoutConvention` (pure rendering) so the
// assertions below check the actual production formatting, not a stand-in.
vi.mock("../layout-convention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout-convention.js")>();
  return { ...actual, scanLayoutConvention: vi.fn() };
});

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import type { LayoutConvention } from "../layout-convention.js";
import { formatLayoutConvention, scanLayoutConvention } from "../layout-convention.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

// Per-test isolated flow dir — a shared dir + fixed runId lets a persisted
// per-sprint plan leak across tests and skip the planning council entirely
// (reused-plan path), so runCouncil never runs and the topic assertions below
// would capture undefined. Same rationale as sprint-runner-backlog.test.ts.
let testFlowDir = "/tmp/flow";

function makeCtx(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "run-test-layout",
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
    folderStructure: "src/analyzers/ (invented by the scoping council)",
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

const TCIS_SHAPED_CONVENTION: LayoutConvention = {
  projectsDir: "src/src",
  projectsCount: 50,
  projectManifestName: "<Name>.csproj",
  testsDir: "src/tests",
  testsCount: 48,
  testSuffix: ".Tests",
  solutionFile: "src/TCISLibraries.sln",
  totalExamples: 98,
};

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
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-layout-"));
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

describe("sprint-runner layout convention reaches the sprint planner (F4b)", () => {
  it("folds the formatted convention block into the exact councilTopic passed to the per-sprint planning council", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(TCIS_SHAPED_CONVENTION);

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // scanLayoutConvention must have been called with the SAME cwd the sprint
    // is running against — not a hardcoded or default path.
    expect(scanLayoutConvention).toHaveBeenCalledWith("/tmp/repo-under-test");

    expect(runCouncil).toHaveBeenCalledTimes(1);
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];

    // This IS the per-sprint planner, not the CB-1 product-scoping council:
    // sprintPlanningMode is the option that marks a per-sprint plan call.
    // runCouncil(topic, model, [], runId, llm, respondQ, respondPreflight, processMessageFn, options)
    const options = firstCall[8];
    expect(options).toMatchObject({ sprintPlanningMode: true });

    // The exact production rendering must be present verbatim — not a
    // paraphrase, not a partial field.
    const expectedBlock = formatLayoutConvention(TCIS_SHAPED_CONVENTION);
    expect(topic).toContain(expectedBlock);
    expect(topic).toContain("src/src/<Name>/<Name>.csproj");
    expect(topic).toContain("src/tests/<Name>.Tests/");
    expect(topic).toContain("(50 found)");
    expect(topic).toContain("(48 found)");
    expect(topic).toContain("src/TCISLibraries.sln");

    // It sits next to the invented folder structure, not instead of it — the
    // planner sees the guess and the evidence side by side.
    expect(topic).toContain("Folder structure: src/analyzers/ (invented by the scoping council)");
    const folderIdx = topic.indexOf("Folder structure:");
    const layoutIdx = topic.indexOf("Layout convention");
    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(layoutIdx).toBeGreaterThan(folderIdx);
  });

  it("adds nothing to councilTopic when the repo has no dominant layout — report-only holds at the call site", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(runCouncil).toHaveBeenCalledTimes(1);
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];

    expect(topic).not.toContain("Layout convention");
    expect(topic).not.toMatch(/\(\d+ found\)/);
  });

  it("swallows a scan failure and still reaches the planner with an unaugmented topic", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("EACCES: permission denied"));

    const ctx = makeCtx();
    const { error } = await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // A scan failure must not halt the sprint (REPORT ONLY, constraint 1).
    expect(error).toBeUndefined();
    expect(runCouncil).toHaveBeenCalledTimes(1);
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];
    expect(topic).not.toContain("Layout convention");
  });
});
