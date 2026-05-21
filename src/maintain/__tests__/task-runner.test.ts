/**
 * task-runner.test.ts — P15 unit tests.
 *
 * Covers:
 *   1. Happy path: 5 phase pairs emitted in order with stable phaseIds + startedAt
 *   2. Judge fail: yields phaseError and returns status="blocked"
 *   3. Review with concerns: surfaces concerns in result and as final chunk
 *   4. Missing verify recipe: returns status="failed" with clear reason
 *   5. Edit stage failure: returns status="failed"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../verify/orchestrator.js", () => ({
  runVerifyOrchestration: vi.fn(),
}));

vi.mock("../../product-loop/done-gate.js", () => ({
  evaluateDoneGate: vi.fn(),
}));

vi.mock("../../council/leader.js", () => ({
  pickCouncilTaskModel: vi.fn((_task: string, leaderId: string) => leaderId),
}));

import { evaluateDoneGate } from "../../product-loop/done-gate.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import type { MaintenanceCtx, RunMaintenanceTaskInput } from "../task-runner.js";
import { runMaintenanceTask } from "../task-runner.js";
import type { CodebaseIntel, MaintenanceTask } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<MaintenanceTask> = {}): MaintenanceTask {
  return {
    id: "01HX1234",
    kind: "bug",
    title: "Fix login redirect",
    description: "After login the user is redirected to /undefined instead of /dashboard",
    acceptance_criteria: ["redirect to /dashboard after login", "no 404 on redirect"],
    candidateFiles: ["src/auth/login.ts"],
    impactRadius: ["src/app.tsx"],
    regressionTestFiles: ["src/auth/__tests__/login.test.ts"],
    status: "queued",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

function makeIntel(overrides: Partial<CodebaseIntel> = {}): CodebaseIntel {
  return {
    cwd: "/tmp/proj",
    repoMap: "src/\n  auth/\n    login.ts\n  app.tsx",
    repoMapSource: "generated",
    candidateFiles: [{ path: "src/auth/login.ts", reason: "filename match", matchScore: 0.9 }],
    impactRadius: ["src/app.tsx"],
    regressionTests: ["src/auth/__tests__/login.test.ts"],
    detectedFrameworks: ["node", "react"],
    capturedAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<MaintenanceCtx> = {}): MaintenanceCtx {
  return {
    runId: "run-maint-test",
    sessionId: "sess-test",
    cwd: "/tmp/proj",
    llm: {
      generate: vi.fn(async (_modelId, _system, _prompt) => "1. Fix redirect in login.ts\n2. Update router"),
    },
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "applying fix..." } as const;
    }),
    detectVerifyRecipe: vi.fn(async () => ({
      ecosystem: "node",
      appKind: "cli",
      appLabel: "Test project",
      shellInitCommands: [],
      bootstrapCommands: [],
      installCommands: [],
      buildCommands: [],
      testCommands: ["npm test"],
      smokeKind: "none" as const,
      evidence: [],
      notes: [],
      coverage: 80,
    })),
    respondToPreflight: vi.fn(async () => true),
    ...overrides,
  };
}

function makeInput(
  ctxOverrides?: Partial<MaintenanceCtx>,
  taskOverrides?: Partial<MaintenanceTask>,
): RunMaintenanceTaskInput {
  return {
    task: makeTask(taskOverrides),
    codebaseIntel: makeIntel(),
    ctx: makeCtx(ctxOverrides),
    leaderModelId: "deepseek-v4-flash",
    costAware: true,
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  let result: R;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      result = step.value as R;
      break;
    }
    chunks.push(step.value as T);
  }
  return { chunks, result: result! };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runMaintenanceTask — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (runVerifyOrchestration as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n2 tests passed",
    });

    (evaluateDoneGate as ReturnType<typeof vi.fn>).mockResolvedValue({
      pass: true,
      score: 0.95,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits 5 active+done phase pairs in order: design, edit, verify, judge, review", async () => {
    const input = makeInput();
    // review model returns no concerns (ok=true)
    (input.ctx.llm.generate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("1. Fix redirect\n2. Update router") // design
      .mockResolvedValueOnce('{"ok": true, "concerns": []}'); // review

    const { chunks, result } = await drain(runMaintenanceTask(input));

    const phaseChunks = chunks.filter((c) => (c as unknown as Record<string, unknown>).type === "council_phase");

    const phases = phaseChunks.map((c) => (c as unknown as { councilPhase: Record<string, unknown> }).councilPhase);

    // Must have active+done for all 5 phases = 10 phase events
    expect(phases.length).toBe(10);

    const expectedPhaseIds = ["maint-design", "maint-edit", "maint-verify", "maint-judge", "maint-review"];
    for (const id of expectedPhaseIds) {
      const forId = phases.filter((p) => p.phaseId === id);
      expect(forId).toHaveLength(2);
      expect(forId[0].state).toBe("active");
      expect(forId[1].state).toBe("done");
      expect(typeof forId[0].startedAt).toBe("number");
      expect(forId[0].startedAt as number).toBeGreaterThan(0);
    }

    // Verify ordering: design active must come before edit active
    const actives = phases.filter((p) => p.state === "active").map((p) => p.phaseId as string);
    expect(actives).toEqual(["maint-design", "maint-edit", "maint-verify", "maint-judge", "maint-review"]);

    expect(result.status).toBe("done");
    expect(result.judgeScore).toBe(0.95);
    expect(result.designPlan).toContain("Fix redirect");
  });

  it("returns status=done with reviewConcerns=[] when review returns ok:true", async () => {
    const input = makeInput();
    (input.ctx.llm.generate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("1. Fix redirect\n2. Update router")
      .mockResolvedValueOnce('{"ok": true, "concerns": []}');

    const { result } = await drain(runMaintenanceTask(input));

    expect(result.status).toBe("done");
    expect(result.reviewConcerns).toEqual([]);
  });
});

describe("runMaintenanceTask — judge fail → blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (runVerifyOrchestration as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      output: "2 tests failed",
      error: "AssertionError: expected /dashboard but got /undefined",
    });

    (evaluateDoneGate as ReturnType<typeof vi.fn>).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "verify_FAIL",
      score: 0.3,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("yields phaseError on judge phase and returns status=blocked", async () => {
    const input = makeInput();
    (input.ctx.llm.generate as ReturnType<typeof vi.fn>).mockResolvedValue("1. Fix redirect");

    const { chunks, result } = await drain(runMaintenanceTask(input));

    // Judge phase must emit an error chunk
    const phaseChunks = chunks
      .filter((c) => (c as unknown as Record<string, unknown>).type === "council_phase")
      .map((c) => (c as unknown as { councilPhase: Record<string, unknown> }).councilPhase);

    const judgeErrorChunk = phaseChunks.find((p) => p.phaseId === "maint-judge" && p.state === "error");
    expect(judgeErrorChunk).toBeDefined();
    expect(typeof judgeErrorChunk!.errorMessage).toBe("string");

    // No review phase emitted when judge halts
    const reviewPhase = phaseChunks.find((p) => p.phaseId === "maint-review");
    expect(reviewPhase).toBeUndefined();

    expect(result.status).toBe("blocked");
    expect(result.judgeScore).toBe(0.3);
    expect(result.failureReason).toBeTruthy();
  });
});

describe("runMaintenanceTask — review with concerns", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (runVerifyOrchestration as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS",
    });

    (evaluateDoneGate as ReturnType<typeof vi.fn>).mockResolvedValue({
      pass: true,
      score: 0.9,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces concerns in result.reviewConcerns and emits a content chunk listing them", async () => {
    const input = makeInput();
    const concernsList = ["No test for null user case", "Missing error boundary for failed fetch"];

    (input.ctx.llm.generate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("1. Fix redirect") // design
      .mockResolvedValueOnce(JSON.stringify({ ok: false, concerns: concernsList })); // review

    const { chunks, result } = await drain(runMaintenanceTask(input));

    expect(result.status).toBe("done");
    expect(result.reviewConcerns).toEqual(concernsList);

    const contentChunks = chunks
      .filter((c) => (c as unknown as Record<string, unknown>).type === "content")
      .map((c) => (c as unknown as { content: string }).content);

    const reviewContent = contentChunks.find((c) => c.includes("Review Concerns"));
    expect(reviewContent).toBeDefined();
    expect(reviewContent).toContain("No test for null user case");
    expect(reviewContent).toContain("Missing error boundary for failed fetch");
  });
});

describe("runMaintenanceTask — missing verify recipe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits phaseError on verify and returns status=failed when detectVerifyRecipe returns null", async () => {
    const input = makeInput({
      detectVerifyRecipe: vi.fn(async () => null),
    });
    (input.ctx.llm.generate as ReturnType<typeof vi.fn>).mockResolvedValue("1. Fix redirect");

    const { chunks, result } = await drain(runMaintenanceTask(input));

    const phaseChunks = chunks
      .filter((c) => (c as unknown as Record<string, unknown>).type === "council_phase")
      .map((c) => (c as unknown as { councilPhase: Record<string, unknown> }).councilPhase);

    const verifyError = phaseChunks.find((p) => p.phaseId === "maint-verify" && p.state === "error");
    expect(verifyError).toBeDefined();
    expect(verifyError!.errorMessage as string).toContain("no verify recipe");

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("no verify recipe");

    // runVerifyOrchestration should NOT have been called
    expect(runVerifyOrchestration).not.toHaveBeenCalled();
  });
});

describe("runMaintenanceTask — edit failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns status=failed when processMessageFn throws", async () => {
    const input = makeInput({
      processMessageFn: vi.fn(async function* () {
        throw new Error("orchestrator exploded");
        // biome-ignore lint/correctness/noUnreachable: needed for generator type inference
        yield { type: "content", content: "" } as const;
      }),
    });
    (input.ctx.llm.generate as ReturnType<typeof vi.fn>).mockResolvedValue("1. Fix redirect");

    const { result } = await drain(runMaintenanceTask(input));

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("orchestrator exploded");
    expect(runVerifyOrchestration).not.toHaveBeenCalled();
  });
});
