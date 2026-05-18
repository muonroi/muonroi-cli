/**
 * sprint-runner-emit.test.ts — Phase 6.3 unit tests.
 *
 * Verifies that runSprint emits the correct harness events at each
 * sprint stage transition (planning, implementation, verification, judgment)
 * and at CB-3 halt, by mocking __muonroiAgentRuntime.
 *
 * Pattern: set globalThis.__muonroiAgentRuntime = { emitEvent: vi.fn() }
 * before running, then assert the emitEvent calls after drain.
 *
 * NOTE: 4.4 zero-overhead guarantee is also tested here — when
 * __muonroiAgentRuntime is unset, runSprint must not throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All external modules are mocked so this test exercises only sprint-runner
// emit side effects, not the underlying implementations.
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

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

function makeCtx(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "run-test-123",
    flowDir: "/tmp/flow",
    cwd: "/tmp/cwd",
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
    folderStructure: "src/",
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

// ---------------------------------------------------------------------------
// Test: zero-overhead when agentRuntime is unset (Phase 4.4)
// ---------------------------------------------------------------------------

describe("sprint-runner emit — 4.4 zero overhead (no agentRuntime)", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = undefined;
    vi.clearAllMocks();
    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ halt: false });
    (evaluateDoneGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ pass: true, score: 1.0 });
    (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text";
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
  });

  it("runSprint completes without throwing when __muonroiAgentRuntime is unset", async () => {
    const ctx = makeCtx();
    const { error } = await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: sprint-stage fires at all 4 stage transitions (happy path)
// ---------------------------------------------------------------------------

describe("sprint-runner emit — sprint-stage (all 4 stage transitions)", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();

    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ halt: false });
    (evaluateDoneGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ pass: true, score: 1.0 });
    (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text";
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
  });

  it("emits sprint-stage for planning, implementation, verification, and judgment", async () => {
    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const sprintStageEvents = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((e) => e.kind === "sprint-stage");

    expect(sprintStageEvents).toHaveLength(4);

    const stages = sprintStageEvents.map((e) => e.stage);
    expect(stages).toContain("planning");
    expect(stages).toContain("implementation");
    expect(stages).toContain("verification");
    expect(stages).toContain("judgment");

    // All should reference sprint 1 and correct runId
    for (const e of sprintStageEvents) {
      expect(e.sprintIndex).toBe(1);
      expect(e.runId).toBe("run-test-123");
      expect(e.t).toBe("event");
    }
  });

  it("emits stages in correct order: planning → implementation → verification → judgment", async () => {
    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 2, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const stageEvents = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((e) => e.kind === "sprint-stage");

    const stageOrder = stageEvents.map((e) => e.stage);
    expect(stageOrder[0]).toBe("planning");
    expect(stageOrder[1]).toBe("implementation");
    expect(stageOrder[2]).toBe("verification");
    expect(stageOrder[3]).toBe("judgment");
  });
});

// ---------------------------------------------------------------------------
// Test: sprint-halt fires before the halt chunk is yielded (CB-3 path)
// ---------------------------------------------------------------------------

describe("sprint-runner emit — sprint-halt (CB-3 gate)", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
  });

  it("emits sprint-halt with correct sprintN and reason when CB-3 fires", async () => {
    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      halt: true,
      reason: "no_recipe",
    });

    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });
    const { chunks } = await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // Verify halt chunk was yielded
    const haltChunks = chunks.filter((c: unknown) => (c as Record<string, unknown>).type === "halt");
    expect(haltChunks).toHaveLength(1);

    // Verify harness event was emitted with correct payload
    const haltEmit = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((e) => e.kind === "sprint-halt");

    expect(haltEmit).toBeDefined();
    expect(haltEmit!.sprintN).toBe(1);
    expect(haltEmit!.reason).toBe("no_recipe");
    expect(haltEmit!.runId).toBe("run-test-123");
    expect(haltEmit!.t).toBe("event");
  });

  it("sprint-halt is emitted BEFORE the halt chunk is yielded", async () => {
    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      halt: true,
      reason: "no_recipe",
    });

    const emitOrder: string[] = [];
    const trackingEmit = vi.fn((e: Record<string, unknown>) => {
      emitOrder.push(`emit:${String(e.kind)}`);
    });
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent: trackingEmit };

    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });
    const gen = runSprint({
      sprintN: 1,
      ctx: ctx as never,
      productSpec: makeSpec(),
      roleAssignments: NO_ROLES,
      history: [],
    });

    const yieldOrder: string[] = [];
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      const chunk = value as unknown as Record<string, unknown>;
      if (chunk.type) {
        yieldOrder.push(`chunk:${String(chunk.type)}`);
        // Record after each yield what emits had happened so far
        const currentEmits = [...emitOrder];
        if (chunk.type === "halt") {
          // At the point the halt chunk is yielded, sprint-halt should already be emitted
          expect(currentEmits).toContain("emit:sprint-halt");
        }
      }
    }
  });
});
