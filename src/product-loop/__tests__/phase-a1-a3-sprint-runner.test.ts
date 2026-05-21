/**
 * phase-a1-a3-sprint-runner.test.ts — Phase A unit tests (A1 + A3).
 *
 * A1: generate_plan no longer exits sprint-runner.
 *     After council selects generate_plan, runSprint continues with
 *     implementation → verification → judgment, emitting all 4 sprint_stage events.
 *
 * A3: sprint-runner emits phaseDone for implementation even when
 *     processMessageFn throws (try/finally guard).
 *
 * These tests call runSprint directly (no mocking of sprint-runner.js itself).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Top-level mocks (hoisted) ──────────────────────────────────────────────

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
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(async () => undefined),
  readCriteria: vi.fn(async () => []),
  writeManifest: vi.fn(async () => undefined),
  readManifest: vi.fn(async () => null),
  markIterationCrashed: vi.fn(async () => undefined),
  readIterations: vi.fn(async () => []),
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
vi.mock("../../providers/runtime.js", () => ({
  detectProviderForModel: vi.fn(() => "anthropic"),
}));
vi.mock("../backlog-store.js", () => ({
  readBacklog: vi.fn(async () => null),
  writeBacklog: vi.fn(async () => undefined),
}));
vi.mock("../assumption-ledger.js", () => ({
  readLedger: vi.fn(async () => null),
  formatUnverifiedForSprintContext: vi.fn(() => ""),
}));
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => null),
}));
vi.mock("../progress-snapshot.js", () => ({
  computeProgressSnapshot: vi.fn(async () => null),
  renderSnapshotMarkdown: vi.fn(() => ""),
}));
vi.mock("../verify-failure-tracking.js", () => ({
  loadVerifyFailureSignatures: vi.fn(async () => ({ signatures: [] })),
  recordVerifyFailureAndMaybePush: vi.fn(async () => undefined),
  computeFailureSignature: vi.fn(() => "sig"),
  pushFailureToEE: vi.fn(async () => undefined),
  saveVerifyFailureSignatures: vi.fn(async () => undefined),
}));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

async function drainWithResult<T, R>(
  gen: AsyncGenerator<T, R, unknown>,
): Promise<{ chunks: T[]; result: R | undefined; error?: unknown }> {
  const chunks: T[] = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, result: value as R };
      chunks.push(value as T);
    }
  } catch (error) {
    return { chunks, result: undefined, error };
  }
}

// ── Common beforeEach ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (CB3_verifyBlank as ReturnType<typeof vi.fn>).mockReturnValue({ halt: false });
  (evaluateDoneGate as ReturnType<typeof vi.fn>).mockResolvedValue({ pass: true, score: 1.0 });
  (runVerifyOrchestration as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    output: "VERIFY_PASS\n",
    verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
});

// ── A1: generate_plan stays within sprint-runner ───────────────────────────

describe("A1: generate_plan no longer exits sprint-runner", () => {
  it("after council returns synthesisText from generate_plan, sprint-runner emits all 4 phase events", async () => {
    const processMessageFn = vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    });

    (runCouncil as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      // Simulate council returning synthesisText from generate_plan
      return "Sprint plan locked (3 steps):\n- [high] Setup auth\n- [high] Build API\n- [medium] Tests";
    });

    const ctx = {
      runId: "run-a1-test",
      flowDir: "/tmp/flow-a1",
      cwd: "/tmp/cwd-a1",
      idea: "test idea",
      sessionModelId: "test-model",
      llm: {
        generate: vi.fn(async () => "synthesis"),
        research: vi.fn(async () => "research"),
      },
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      processMessageFn,
      detectVerifyRecipe: vi.fn(async () => ({
        testCommands: ["npm test"],
        coverage: 80,
        shellInitCommands: [],
      })),
    };

    const { chunks } = await drainWithResult(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // All 4 sprint_stage "active" events must fire
    const phaseActives = chunks
      .filter(
        (c) =>
          (c as unknown as Record<string, unknown>).type === "council_phase" &&
          ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>)?.kind ===
            "sprint_stage" &&
          ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>)?.state === "active",
      )
      .map(
        (c) => ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>).phaseId as string,
      );

    expect(phaseActives).toContain("sprint-1-planning");
    expect(phaseActives).toContain("sprint-1-implementation");
    expect(phaseActives).toContain("sprint-1-verification");
    expect(phaseActives).toContain("sprint-1-judgment");

    // processMessageFn was called with the locked plan synthesisText
    expect(processMessageFn).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((processMessageFn.mock.calls as any)[0][0]).toContain("Sprint plan locked");
  });
});

// ── A3: phaseDone fires even when processMessageFn throws ─────────────────

describe("A3: sprint-runner emits phaseDone even when processMessageFn throws", () => {
  it("emits phaseError for implementation and throws, but does NOT leave phase stuck in active", async () => {
    (runCouncil as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "planning..." };
      return "do the thing";
    });

    const ctx = {
      runId: "run-a3-test",
      flowDir: "/tmp/flow-a3",
      cwd: "/tmp/cwd-a3",
      idea: "test idea",
      sessionModelId: "test-model",
      llm: {
        generate: vi.fn(async () => "synthesis"),
        research: vi.fn(async () => "research"),
      },
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      // processMessageFn throws mid-stream
      processMessageFn: vi.fn(async function* () {
        yield { type: "content", content: "partial work done..." };
        throw new Error("executor failed mid-stream");
      }),
      detectVerifyRecipe: vi.fn(async () => ({
        testCommands: ["npm test"],
        coverage: 80,
        shellInitCommands: [],
      })),
    };

    const { chunks, error } = await drainWithResult(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // An error was thrown (processMessageFn threw)
    expect(error).toBeDefined();
    expect(String(error)).toContain("executor failed mid-stream");

    // The implementation phase MUST have a non-active close event (phaseError or phaseDone)
    const implPhaseChunks = chunks
      .filter(
        (c) =>
          (c as unknown as Record<string, unknown>).type === "council_phase" &&
          ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>)?.phaseId ===
            "sprint-1-implementation",
      )
      .map((c) => ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>).state as string);

    // Must have "active" start
    expect(implPhaseChunks).toContain("active");
    // Must have "error" close (phaseError was yielded via try/finally)
    expect(implPhaseChunks).toContain("error");
    // Must NOT end stuck in only "active" (i.e., must have both active and error)
    expect(implPhaseChunks.length).toBeGreaterThanOrEqual(2);
  });

  it("emits phaseDone for implementation even when processMessageFn is absent (skip path)", async () => {
    (runCouncil as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "planning..." };
      return "plan text";
    });

    const ctx = {
      runId: "run-a3-skip",
      flowDir: "/tmp/flow-a3-skip",
      cwd: "/tmp/cwd-a3-skip",
      idea: "test idea",
      sessionModelId: "test-model",
      llm: {
        generate: vi.fn(async () => "synthesis"),
        research: vi.fn(async () => "research"),
      },
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      // No processMessageFn — should emit phaseDone on skip path
      processMessageFn: undefined,
      detectVerifyRecipe: vi.fn(async () => ({
        testCommands: ["npm test"],
        coverage: 80,
        shellInitCommands: [],
      })),
    };

    const { chunks } = await drainWithResult(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const implPhaseChunks = chunks
      .filter(
        (c) =>
          (c as unknown as Record<string, unknown>).type === "council_phase" &&
          ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>)?.phaseId ===
            "sprint-1-implementation",
      )
      .map((c) => ((c as unknown as Record<string, unknown>).councilPhase as Record<string, unknown>).state as string);

    expect(implPhaseChunks).toContain("active");
    expect(implPhaseChunks).toContain("done");
  });
});
