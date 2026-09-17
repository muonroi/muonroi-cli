/**
 * src/product-loop/__tests__/sprint-tracking.test.ts
 *
 * S1 — the tracked task list (tasks.json) and the sprint register
 * (sprint-plan.json) must change as sprints actually run, instead of staying
 * frozen at whatever the initial plan wrote. This exercises the shared
 * `runSprintTracked` wrapper (index.ts's phase adapter AND the legacy
 * drainSprints loop both call this exact function — see index.ts) with a
 * STUBBED `runSprint`, so the heavy machinery `runSprint` itself needs
 * (council, verify, done-gate, ...) never has to be mocked here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));

import { writeSprintOutcome } from "../../flow/run-artifacts.js";
import { runSprint } from "../sprint-runner.js";
import * as sprintStore from "../sprint-store.js";
import { readSprintPlan } from "../sprint-store.js";
import { markSprintFinished, markSprintStarted, resolveSprintVerdict, runSprintTracked } from "../sprint-tracking.js";
import * as typedArtifacts from "../typed-artifacts.js";
import { deriveTasksFromSpec, readTasks, writeTasks } from "../typed-artifacts.js";
import type { DriverContext, IterationState, ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let tmpDir: string;
const runId = "run-s1-test";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "sprint-tracking-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat one", "feat two"],
    phase2: ["later feat"],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

function makeCtx(): DriverContext {
  return {
    runId,
    flowDir: tmpDir,
    idea: "test idea",
    sessionModelId: "test-model",
    llm: { generate: vi.fn(), research: vi.fn(), debate: vi.fn() } as unknown as DriverContext["llm"],
    flags: { doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
  } as unknown as DriverContext;
}

function makeIter(overrides: Partial<IterationState> = {}): IterationState {
  return {
    sprintN: 1,
    stage: "shipped",
    scoreBefore: 0,
    scoreAfter: 1,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0,
    lastVerifyResult: "PASS",
    ...overrides,
  };
}

/** Seed tasks.json exactly the way loop-driver.ts does (deriveTasksFromSpec). */
async function seedTasks(): Promise<void> {
  await writeTasks(tmpDir, runId, deriveTasksFromSpec(makeSpec()));
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R> {
  let result: R;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
  }
  return result!;
}

describe("markSprintStarted", () => {
  it("creates a new active sprint-plan.json entry when none exists", async () => {
    await markSprintStarted(tmpDir, runId, 1);
    const plan = await readSprintPlan(tmpDir, runId);
    expect(plan).not.toBeNull();
    const s1 = plan!.sprints.find((s) => s.number === 1);
    expect(s1?.status).toBe("active");
    expect(s1?.startedAtUtc).toBeTruthy();
    expect(plan!.activeSprintId).toBe("sprint-1");
  });

  it("moves matching pending tasks to in_progress and leaves others alone", async () => {
    await seedTasks();
    await markSprintStarted(tmpDir, runId, 1); // mvp tasks are estimate.sprint=1
    const tasks = await readTasks(tmpDir, runId);
    const mvpTasks = tasks.filter((t) => t.source === "mvp");
    const p2Tasks = tasks.filter((t) => t.source === "phase2");
    expect(mvpTasks.every((t) => t.status === "in_progress")).toBe(true);
    expect(p2Tasks.every((t) => t.status === "pending")).toBe(true);
  });
});

describe("markSprintFinished", () => {
  it("marks the sprint done with the verdict and moves matching tasks to done on pass", async () => {
    await seedTasks();
    await markSprintStarted(tmpDir, runId, 1);
    await markSprintFinished(tmpDir, runId, 1, { pass: true, score: 1, verify: "PASS" });

    const plan = await readSprintPlan(tmpDir, runId);
    const s1 = plan!.sprints.find((s) => s.number === 1)!;
    expect(s1.status).toBe("done");
    expect(s1.endedAtUtc).toBeTruthy();
    expect(s1.verdict).toEqual({ pass: true, score: 1, verify: "PASS" });

    const tasks = await readTasks(tmpDir, runId);
    expect(tasks.filter((t) => t.source === "mvp").every((t) => t.status === "done")).toBe(true);
  });

  it("leaves failed-sprint tasks in_progress, never blocked", async () => {
    await seedTasks();
    await markSprintStarted(tmpDir, runId, 1);
    await markSprintFinished(tmpDir, runId, 1, {
      pass: false,
      failedCondition: "engineering_floor",
      reason: "verify_FAIL",
    });

    const tasks = await readTasks(tmpDir, runId);
    expect(tasks.filter((t) => t.source === "mvp").every((t) => t.status === "in_progress")).toBe(true);

    const plan = await readSprintPlan(tmpDir, runId);
    const s1 = plan!.sprints.find((s) => s.number === 1)!;
    expect(s1.status).toBe("done");
    expect(s1.verdict?.pass).toBe(false);
    expect(s1.verdict?.failedCondition).toBe("engineering_floor");
  });

  it("never regresses a task already done or blocked", async () => {
    await seedTasks();
    let tasks = await readTasks(tmpDir, runId);
    tasks[0]!.status = "done";
    tasks[1]!.status = "blocked";
    await writeTasks(tmpDir, runId, tasks);

    await markSprintFinished(tmpDir, runId, 1, { pass: false });
    tasks = await readTasks(tmpDir, runId);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[1]!.status).toBe("blocked");
  });
});

describe("resolveSprintVerdict", () => {
  it("prefers the authoritative SprintOutcome file when present", async () => {
    await writeSprintOutcome(tmpDir, runId, {
      sprintN: 1,
      pass: true,
      score: 0.95,
      verify: "PASS",
      criteriaMet: 3,
      criteriaPartial: 0,
      criteriaUnmet: 0,
      finishedAt: new Date().toISOString(),
    });
    const verdict = await resolveSprintVerdict(tmpDir, runId, 1, makeIter({ stage: "retrospective" }));
    // outcome file says pass=true even though iter.stage says otherwise — outcome wins.
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBe(0.95);
  });

  it("falls back to IterationState.stage when no outcome file exists", async () => {
    const verdict = await resolveSprintVerdict(
      tmpDir,
      runId,
      7,
      makeIter({ stage: "retrospective", lastVerifyResult: "FAIL" }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("FAIL");
  });
});

describe("runSprintTracked — phase-adapter and legacy drainSprints both call this", () => {
  it("registers sprint 1 then sprint 2, each with the correct final status", async () => {
    await seedTasks();
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* (args: { sprintN: number }) {
      yield { type: "content", content: `sprint ${args.sprintN}` };
      return makeIter({ sprintN: args.sprintN, stage: "shipped" });
    });

    const ctx = makeCtx();
    await drain(runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));
    await drain(runSprintTracked({ sprintN: 2, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));

    const plan = await readSprintPlan(tmpDir, runId);
    expect(plan!.sprints).toHaveLength(2);
    const s1 = plan!.sprints.find((s) => s.number === 1)!;
    const s2 = plan!.sprints.find((s) => s.number === 2)!;
    expect(s1.status).toBe("done");
    expect(s1.verdict?.pass).toBe(true);
    expect(s2.status).toBe("done");
    expect(s2.verdict?.pass).toBe(true);
  });

  it("re-running the same sprint number updates the entry in place, never duplicates", async () => {
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* (args: { sprintN: number }) {
      // No content chunks for this stub — yield* [] keeps this a real generator
      // (biome lint/correctness/useYield) without changing observable behaviour.
      yield* [];
      return makeIter({ sprintN: args.sprintN, stage: "retrospective", lastVerifyResult: "FAIL" });
    });
    const ctx = makeCtx();
    await drain(runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));
    await drain(runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));

    const plan = await readSprintPlan(tmpDir, runId);
    expect(plan!.sprints.filter((s) => s.number === 1)).toHaveLength(1);
  });

  it("moves tasks.json statuses across the sprint 1 -> sprint 2 boundary", async () => {
    await seedTasks();
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* (args: { sprintN: number }) {
      // No content chunks for this stub — yield* [] keeps this a real generator
      // (biome lint/correctness/useYield) without changing observable behaviour.
      yield* [];
      return makeIter({ sprintN: args.sprintN, stage: "shipped" });
    });
    const ctx = makeCtx();
    await drain(runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));

    let tasks = await readTasks(tmpDir, runId);
    expect(tasks.filter((t) => t.source === "mvp").every((t) => t.status === "done")).toBe(true);
    expect(tasks.filter((t) => t.source === "phase2").every((t) => t.status === "pending")).toBe(true);

    await drain(runSprintTracked({ sprintN: 2, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));
    tasks = await readTasks(tmpDir, runId);
    expect(tasks.filter((t) => t.source === "phase2").every((t) => t.status === "done")).toBe(true);
  });

  it("finishes the loop and logs when the sprint-plan store write throws", async () => {
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* (args: { sprintN: number }) {
      // No content chunks for this stub — yield* [] keeps this a real generator
      // (biome lint/correctness/useYield) without changing observable behaviour.
      yield* [];
      return makeIter({ sprintN: args.sprintN, stage: "shipped" });
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upsertSpy = vi.spyOn(sprintStore, "upsertSprint").mockRejectedValue(new Error("disk full (simulated)"));

    const ctx = makeCtx();
    const result = await drain(
      runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // The generator still completes and returns the sprint's real result.
    expect(result.stage).toBe("shipped");
    // The failure was logged with the module prefix, never swallowed.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[product-loop/sprint-tracking]"))).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("disk full (simulated)"))).toBe(true);

    upsertSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("finishes the loop and logs when the tasks.json store write throws", async () => {
    await seedTasks();
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* (args: { sprintN: number }) {
      // No content chunks for this stub — yield* [] keeps this a real generator
      // (biome lint/correctness/useYield) without changing observable behaviour.
      yield* [];
      return makeIter({ sprintN: args.sprintN, stage: "shipped" });
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeTasksSpy = vi.spyOn(typedArtifacts, "writeTasks").mockRejectedValue(new Error("EACCES (simulated)"));

    const ctx = makeCtx();
    const result = await drain(
      runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(result.stage).toBe("shipped");
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[product-loop/sprint-tracking]"))).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("EACCES (simulated)"))).toBe(true);
    // The sprint-plan write (a separate try/catch) still succeeded despite the tasks failure.
    const plan = await readSprintPlan(tmpDir, runId);
    expect(plan!.sprints.find((s) => s.number === 1)?.status).toBe("done");

    writeTasksSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does not record a verdict when the sprint halts", async () => {
    (runSprint as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "halt", haltChunk: { type: "halt", reason: "no_recipe", recovery_options: [] } };
      return undefined as unknown as IterationState;
    });
    const ctx = makeCtx();
    const gen = runSprintTracked({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as { type: string }).type).toBe("halt");
    // Mirrors production: callers stop pulling once they see the halt chunk.

    const plan = await readSprintPlan(tmpDir, runId);
    const s1 = plan!.sprints.find((s) => s.number === 1)!;
    expect(s1.status).toBe("active"); // left as the start hook set it — no fabricated verdict
    expect(s1.verdict).toBeUndefined();
  });
});
