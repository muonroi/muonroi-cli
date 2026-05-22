/**
 * route-decision-emit.test.ts — Phase 6.4 unit tests.
 *
 * Verifies that runHotPath and runStart emit the route-decision harness event
 * with the correct `path` field, by mocking __muonroiAgentRuntime.
 *
 * runHotPath is accessed via runProductLoop with complexity="low".
 * runStart is accessed via runProductLoop with complexity="high".
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));
vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 1, mistakes: 0, stored: 1 })),
}));
vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

// runStart calls runLoopDriver which eventually calls llm/council — stub the
// parts that would fail in a unit test context by making runSprint resolve
// immediately to simulate the full sprint cycle.
vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(),
}));

// A2: mock backlog/sprint-plan I/O so buildBacklogAndSprintPlan returns quickly.
vi.mock("../backlog-store.js", () => ({
  readBacklog: vi.fn(async () => null),
  writeBacklog: vi.fn(async () => undefined),
}));
vi.mock("../sprint-store.js", () => ({
  readSprintPlan: vi.fn(async () => null),
  writeSprintPlan: vi.fn(async () => undefined),
  setActiveSprint: vi.fn(async () => undefined),
}));
vi.mock("../backlog-builder.js", () => ({
  buildBacklog: vi.fn(async () => ({
    runId: "test-run",
    productSlug: "test",
    items: [],
    derivedFromClarifyId: "abc123",
    createdAtUtc: new Date().toISOString(),
  })),
}));
vi.mock("../sprint-planner.js", () => ({
  planSprints: vi.fn(async () => ({
    runId: "test-run",
    sprints: [{ id: "sprint-1", number: 1, goal: "go", itemIds: [], status: "planned" }],
    createdAtUtc: new Date().toISOString(),
  })),
  applySprintAssignments: vi.fn(async () => undefined),
}));
// Dynamic imports inside buildBacklogAndSprintPlan
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => null),
}));
vi.mock("../gather.js", () => ({
  clarifiedSpecFromContext: vi.fn(() => ({
    problemStatement: "test",
    constraints: [],
    successCriteria: [],
    scope: "test",
    rawQA: [],
    resolved: {},
  })),
}));

import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "route-dec-emit-"));
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

function shippedIter(sprintN = 1): IterationState {
  return {
    sprintN,
    stage: "shipped",
    scoreBefore: 0,
    scoreAfter: 1.0,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0.1,
    lastVerifyResult: "PASS",
  };
}

function makeOpts(flowDir: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    flowDir,
    idea: "build something",
    subcommand: "start",
    sessionModelId: getTestModels().balanced,
    sessionId: "test-session-id",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 8, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "ok" };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    // mode="new" bypasses Mode C auto-detection so runHotPath / runStart are exercised
    // (Mode C would dispatch to runMaintain and emit path="maintain" instead).
    mode: "new",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("route-decision emit — runHotPath (path=hot-path)", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();
    process.env.MUONROI_PHASE_MODE = "0";

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return shippedIter(1);
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("emits route-decision with path=hot-path for complexity=low", async () => {
    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never));

    const routeDecisions = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((e) => e.kind === "route-decision");

    expect(routeDecisions.length).toBeGreaterThanOrEqual(1);
    expect(routeDecisions[0]!.path).toBe("hot-path");
    expect(routeDecisions[0]!.forceCouncil).toBe(false);
    expect(routeDecisions[0]!.t).toBe("event");
    expect(typeof routeDecisions[0]!.runId).toBe("string");
    expect(routeDecisions[0]!.runId).not.toBe("");
  });
});

describe("route-decision emit — runStart (path=council)", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();
    process.env.MUONROI_PHASE_MODE = "0";

    // Mock the loop-driver to yield done immediately so runStart completes
    (runLoopDriver as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "running" };
      return { success: true, stage: "shipped", sprintsRun: 1, shipped: true };
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("emits route-decision with path=council for complexity=high", async () => {
    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir, { complexity: "high" }) as never));

    const routeDecisions = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((e) => e.kind === "route-decision");

    expect(routeDecisions.length).toBeGreaterThanOrEqual(1);
    expect(routeDecisions[0]!.path).toBe("council");
    expect(routeDecisions[0]!.t).toBe("event");
  });

  it("emits route-decision with path=council when forceCouncil=true (complexity=low)", async () => {
    const flowDir = await tmpFlowDir();
    await drain(
      runProductLoop(
        makeOpts(flowDir, {
          complexity: "low",
          flags: { maxCost: 50, maxSprints: 8, doneThreshold: 0.9, forceCouncil: true },
        }) as never,
      ),
    );

    const routeDecisions = emitEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((e) => e.kind === "route-decision");

    expect(routeDecisions.length).toBeGreaterThanOrEqual(1);
    expect(routeDecisions[0]!.path).toBe("council");
    expect(routeDecisions[0]!.forceCouncil).toBe(true);
  });
});

describe("route-decision emit — zero overhead when agentRuntime unset", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = undefined;
    vi.clearAllMocks();
    process.env.MUONROI_PHASE_MODE = "0";

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return shippedIter(1);
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("runProductLoop (hot-path) completes without throwing when no agentRuntime", async () => {
    const flowDir = await tmpFlowDir();
    await expect(drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never))).resolves.toBeDefined();
  });
});
