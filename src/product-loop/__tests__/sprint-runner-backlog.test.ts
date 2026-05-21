/**
 * sprint-runner-backlog.test.ts — P6 smoke tests for backlog anchor injection.
 *
 * Verifies that runSprint prepends "## Active Backlog Item" to the councilTopic
 * when a backlog with in_sprint items exists for the current sprint, and does
 * NOT add the anchor when no backlog.json file is present.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All external modules mocked identically to sprint-runner-emit.test.ts pattern.
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

// Mock backlog-store to control what readBacklog returns.
vi.mock("../backlog-store.js", () => ({
  readBacklog: vi.fn(async () => null),
}));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { readBacklog } from "../backlog-store.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { Backlog, BacklogItem, ProductSpec, RoleSlot } from "../types.js";

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

function makeBacklogWithInSprintItem(sprintKey = "sprint-1"): Backlog {
  const item: BacklogItem = {
    id: "item-abc",
    title: "Login feature",
    description: "Allow users to log in",
    acceptance_criteria: ["user can log in with email"],
    entities: [],
    endpoints: [],
    mvp_priority: "v1",
    status: "in_sprint",
    assigned_sprint: sprintKey,
    effortPoints: 3,
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    updatedAtUtc: "2026-01-01T00:00:00.000Z",
  };
  return {
    runId: "run-test-123",
    productSlug: "my-app",
    items: [item],
    derivedFromClarifyId: "abcd1234abcd1234",
    createdAtUtc: "2026-01-01T00:00:00.000Z",
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
// Setup mocks common to all tests
// ---------------------------------------------------------------------------

beforeEach(() => {
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
  // Default: no backlog
  (readBacklog as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sprint-runner backlog anchor (P6)", () => {
  it("injects 'Active Backlog Item' into councilTopic when in_sprint item exists", async () => {
    // Arrange: backlog with 1 in_sprint item for sprint-1
    (readBacklog as ReturnType<typeof vi.fn>).mockResolvedValue(makeBacklogWithInSprintItem("sprint-1"));

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // Assert: the first argument to runCouncil contains the backlog anchor
    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const topic: string = firstCall[0];
    expect(topic).toContain("Active Backlog Item");
    expect(topic).toContain("Login feature");
  });

  it("does NOT inject 'Active Backlog Item' when backlog.json is missing", async () => {
    // readBacklog already mocked to return null in beforeEach
    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const topic: string = firstCall[0];
    expect(topic).not.toContain("Active Backlog Item");
  });

  it("falls back to first v1 backlog item when no in_sprint item for this sprint", async () => {
    // Backlog item is v1 + status=backlog (not yet assigned to a sprint)
    const backlog: Backlog = {
      runId: "run-test-123",
      productSlug: "my-app",
      items: [
        {
          id: "item-v1",
          title: "Dashboard feature",
          description: "Main dashboard",
          acceptance_criteria: ["dashboard loads in <2s"],
          entities: [],
          endpoints: [],
          mvp_priority: "v1",
          status: "backlog",
          effortPoints: 3,
          createdAtUtc: "2026-01-01T00:00:00.000Z",
          updatedAtUtc: "2026-01-01T00:00:00.000Z",
        },
      ],
      derivedFromClarifyId: "abcd1234",
      createdAtUtc: "2026-01-01T00:00:00.000Z",
    };
    (readBacklog as ReturnType<typeof vi.fn>).mockResolvedValue(backlog);

    const ctx = makeCtx();
    await drain(
      runSprint({ sprintN: 1, ctx: ctx as never, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const firstCall = (runCouncil as ReturnType<typeof vi.fn>).mock.calls[0];
    const topic: string = firstCall[0];
    expect(topic).toContain("Active Backlog Item");
    expect(topic).toContain("Dashboard feature");
  });
});
