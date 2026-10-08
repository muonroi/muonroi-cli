/**
 * `run-finished.sprintsRun` must report the sprints that actually ran.
 *
 * Measured defect — run `mtv9v1xu7615` ended with the terminal event
 * `outcome: "threw", success: false, sprintsRun: 0, shipped: false`, while the
 * `sprint_stage` rows record three sprints (sprint 1 at 08:59, sprint 2 at
 * 09:31, sprint 3 at 09:43). A post-mortem field that reads 0 after three
 * sprints is worse than absent.
 *
 * The cause is NOT a counter that was skipped. It is two separate holes:
 *   1. `runProductLoop`'s `catch` (and the `abandoned` `finally`) HARDCODED
 *      `sprintsRun: 0` — the exception escaped before any result existed, so
 *      the arm had no count to report and invented one.
 *   2. `runPhasesPath` — the DEFAULT driver (`MUONROI_PHASE_MODE !== "0"`) —
 *      never populated `sprintsRun` on ANY of its returns, so even a run that
 *      ended cleanly reported `undefined ?? 0`.
 * Run mtv9v1xu7615 hit both: the phase path threw out of `sprintRunner`, which
 * has no try/catch, so the error escaped all the way to the `catch` arm.
 *
 * The counter is therefore published to the same sink that already carries the
 * run id for exactly this reason, and it counts sprints STARTED — which is what
 * the `sprint_stage` rows record, and what makes a sprint that died mid-flight
 * still appear in its own post-mortem.
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
import { runPhases } from "../phase-runner.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

function iterAt(sprintN: number, stage: IterationState["stage"] = "verified"): IterationState {
  return {
    sprintN,
    stage,
    scoreBefore: 0,
    scoreAfter: 0.5,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 1,
    costUsd: 0.1,
    lastVerifyResult: "FAIL",
  };
}

/** The exact reason string run mtv9v1xu7615 died with. */
const ISOLATED_IMPL_TIMEOUT =
  "isolated implementation stage exceeded 900s total watchdog (sprint 3) and was CANCELLED after 900.0s";

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sprints-run-"));
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
    flags: { maxCost: 50, maxSprints: 8, doneThreshold: 0.9, forceCouncil: true },
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

function runFinished(emitEvent: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return emitEvent.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((e) => e?.["kind"] === "run-finished");
}

describe("run-finished.sprintsRun — the throw path must report the real count", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();
    // The phase path refuses to run against a blind spend meter (CB-0) and the
    // test session has no `sessions` row, so authorise the unmetered run.
    process.env.MUONROI_IDEAL_ALLOW_BLIND_BUDGET = "1";
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

  it("legacy path: 3 sprints started, the 3rd throws → sprintsRun=3, not 0", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    let n = 0;
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* () {
        n += 1;
        if (n === 3) throw new Error(ISOLATED_IMPL_TIMEOUT);
        return iterAt(n);
      },
    );
    const flowDir = await tmpFlowDir();
    const { result } = await drain(runProductLoop(makeOpts(flowDir) as never));

    expect(n).toBe(3);
    expect((result as { sprintsRun?: number }).sprintsRun).toBe(3);
    const finished = runFinished(emitEvent);
    expect(finished).toHaveLength(1);
    expect(finished[0]!["sprintsRun"]).toBe(3);
  });

  it("phase path (the default driver): a sprint that throws still counts", async () => {
    // This is run mtv9v1xu7615's exact shape — the phase orchestrator's
    // sprintRunner adapter has no try/catch, so the impl-stage throw escapes
    // runPhasesPath, dispatchProductLoop and lands in runProductLoop's catch.
    delete process.env.MUONROI_PHASE_MODE;
    const { readProjectContext } = await import("../discovery-persistence.js");
    vi.mocked(readProjectContext).mockResolvedValue({
      runId: "r",
      answers: {},
      summary: "ctx",
    } as never);

    let started = 0;
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* (a: { sprintN: number }) {
        started += 1;
        if (started === 3) throw new Error(ISOLATED_IMPL_TIMEOUT);
        return iterAt(a.sprintN);
      },
    );
    (runPhases as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* (a: {
      sprintRunner: (c: unknown) => AsyncGenerator<unknown, IterationState, unknown>;
    }) {
      for (let s = 1; s <= 3; s++) {
        const g = a.sprintRunner({ sprintN: s, phaseId: "p1" });
        while (true) {
          const step = await g.next();
          if (step.done) break;
          yield step.value;
        }
      }
      return { pass: true };
    });

    const flowDir = await tmpFlowDir();
    await expect(drain(runProductLoop(makeOpts(flowDir) as never))).rejects.toThrow(/CANCELLED after 900.0s/);

    expect(started).toBe(3);
    const finished = runFinished(emitEvent);
    expect(finished).toHaveLength(1);
    expect(finished[0]!["outcome"]).toBe("threw");
    expect(finished[0]!["sprintsRun"]).toBe(3);
  });

  it("phase path: a clean run reports its sprint count too (it reported undefined→0 before)", async () => {
    delete process.env.MUONROI_PHASE_MODE;
    const { readProjectContext } = await import("../discovery-persistence.js");
    vi.mocked(readProjectContext).mockResolvedValue({
      runId: "r",
      answers: {},
      summary: "ctx",
    } as never);

    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* (a: { sprintN: number }) {
        return iterAt(a.sprintN);
      },
    );
    (runPhases as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* (a: {
      sprintRunner: (c: unknown) => AsyncGenerator<unknown, IterationState, unknown>;
    }) {
      for (let s = 1; s <= 2; s++) {
        const g = a.sprintRunner({ sprintN: s, phaseId: "p1" });
        while (true) {
          const step = await g.next();
          if (step.done) break;
          yield step.value;
        }
      }
      return { pass: false, reason: "still-failing" };
    });

    const flowDir = await tmpFlowDir();
    const { result } = await drain(runProductLoop(makeOpts(flowDir) as never));
    expect((result as { sprintsRun?: number }).sprintsRun).toBe(2);
    expect(runFinished(emitEvent)[0]!["sprintsRun"]).toBe(2);
  });

  it("reports 0 only when zero sprints were started", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* () {
        return iterAt(1, "shipped");
      },
    );
    const flowDir = await tmpFlowDir();
    // maxSprints:0 → the loop body never runs.
    const { result } = await drain(
      runProductLoop(
        makeOpts(flowDir, {
          flags: { maxCost: 50, maxSprints: 0, doneThreshold: 0.9, forceCouncil: true },
        }) as never,
      ),
    );
    expect((result as { sprintsRun?: number }).sprintsRun).toBe(0);
    expect(runFinished(emitEvent)[0]!["sprintsRun"]).toBe(0);
  });
});
