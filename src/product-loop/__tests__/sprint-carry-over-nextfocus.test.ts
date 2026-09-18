/**
 * S8 — the legacy `drainSprints` loop (`MUONROI_PHASE_MODE=0`) must prefer
 * `iter.nextFocus` (the detailed carry-over focus built by
 * `buildContinueFeedback` + S5/S6 must-fix items + residual plan deviations +
 * S3b unfinished tasks — see `sprint-runner.ts` Step 9) over the bare
 * `fix verify failures (last result: ...)` string it used to overwrite it
 * with. The phase-orchestrated path (`product-loop/index.ts` ~1666) already
 * threads `nextFocus` correctly; this file pins the legacy path to the same
 * behavior.
 *
 * Reached via `MUONROI_PHASE_MODE=0`, which routes `runProductLoop` straight
 * into `drainSprints` (see `index.ts` ~1100: `if (process.env.MUONROI_PHASE_MODE
 * !== "0") { ...phase path... }` — falls through to `drainSprints` otherwise).
 * `runSprint` (sprint-runner.ts) is mocked so each call to `drainSprints`'s
 * `runSprintTracked({ ..., carryOver })` — which forwards `carryOver` verbatim
 * to `runSprint` (see `sprint-tracking.ts:199`) — lets us read the exact
 * `carryOver.focus` the next sprint received off `runSprint.mock.calls`.
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
vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(),
}));
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
vi.mock("../phase-runner.js", () => ({
  runPhases: vi.fn(),
}));

import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

function iterAt(sprintN: number, overrides: Partial<IterationState> = {}): IterationState {
  return {
    sprintN,
    stage: "retrospective",
    scoreBefore: 0,
    scoreAfter: 0.5,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 1,
    costUsd: 0.1,
    lastVerifyResult: "FAIL",
    ...overrides,
  };
}

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sprint-carry-over-"));
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

function makeOpts(flowDir: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    flowDir,
    idea: "build something",
    subcommand: "start",
    sessionModelId: getTestModels().balanced,
    sessionId: "test-session-id",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 2, doneThreshold: 0.9, forceCouncil: true },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "ok" };
    }),
    complexity: "high",
    mode: "new",
    ...overrides,
  };
}

describe("drainSprints (legacy MUONROI_PHASE_MODE=0) — carry-over focus", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent: vi.fn() };
    vi.clearAllMocks();
    process.env.MUONROI_IDEAL_ALLOW_BLIND_BUDGET = "1";
    process.env.MUONROI_PHASE_MODE = "0";
    (runLoopDriver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* () {
        return { runId: "r", stage: "approved", success: true };
      },
    );
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_PHASE_MODE;
    delete process.env.MUONROI_IDEAL_ALLOW_BLIND_BUDGET;
  });

  it("threads iter.nextFocus into the next sprint's carryOver.focus exactly", async () => {
    const detailedFocus =
      "fix verify failures (engineering_floor)\n\nboom: verify output\n\nPlan deviations still open (address these next):\n- touched an out-of-scope file";
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* (args: { sprintN: number }) {
        if (args.sprintN === 1) return iterAt(1, { nextFocus: detailedFocus });
        return iterAt(2, { stage: "shipped" });
      },
    );

    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir) as never));

    const calls = (runSprint as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const secondCallArgs = calls[1]![0] as { carryOver?: { focus?: string } };
    expect(secondCallArgs.carryOver?.focus).toBe(detailedFocus);
  });

  it("falls back to the bare verify-failure string when nextFocus is absent", async () => {
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* (args: { sprintN: number }) {
        if (args.sprintN === 1) return iterAt(1, { lastVerifyResult: "FAIL" });
        return iterAt(2, { stage: "shipped" });
      },
    );

    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir) as never));

    const calls = (runSprint as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const secondCallArgs = calls[1]![0] as { carryOver?: { focus?: string } };
    expect(secondCallArgs.carryOver?.focus).toBe("fix verify failures (last result: FAIL)");
  });

  it("a pass with unmet criteria (no nextFocus) still carries a sensible focus string", async () => {
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* (args: { sprintN: number }) {
        if (args.sprintN === 1) {
          return iterAt(1, {
            lastVerifyResult: "PASS",
            criteriaMet: 2,
            criteriaPartial: 1,
            criteriaUnmet: 1,
          });
        }
        return iterAt(2, { stage: "shipped" });
      },
    );

    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir) as never));

    const calls = (runSprint as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const secondCallArgs = calls[1]![0] as { carryOver?: { focus?: string } };
    // Actual behavior: with no nextFocus, a PASS falls back to the criteria-coverage
    // summary string (met/partial/unmet counts), not the verify-failure string.
    expect(secondCallArgs.carryOver?.focus).toBe("improve criteria coverage: met=2, partial=1, unmet=1");
  });
});
