/**
 * Unit tests for runHotPath (P2.5).
 *
 * runProductLoop routes complexity="low" + forceCouncil unset to the hot-path.
 * These tests verify:
 *  - hot-path runs exactly 1 sprint
 *  - extractRunToEE is called on shipped result
 *  - result is success=true / shipped=true / sprintsRun=1
 *  - when sprint returns non-shipped stage, result is halted with NO retry
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));

vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 1, mistakes: 0, stored: 1 })),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

import { extractRunToEE } from "../cross-run-memory.js";
import { runProductLoop } from "../index.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hot-path-"));
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    flowDir: overrides.flowDir as string,
    idea: overrides.idea ?? "build a counter",
    subcommand: "start",
    sessionModelId: "claude-sonnet-4-6",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 8, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    // Hot-path routing fields
    complexity: "low",
    ...overrides,
  };
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
    criteriaMet: 3,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0.2,
    lastVerifyResult: "PASS",
    actualCost: 0.2,
    score: 1.0,
  };
}

function retrospectiveIter(sprintN = 1): IterationState {
  return {
    sprintN,
    stage: "retrospective",
    scoreBefore: 0,
    scoreAfter: 0.4,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 2,
    costUsd: 0.2,
    lastVerifyResult: "FAIL",
  };
}

describe("runHotPath — P2.5", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force phase-mode off so runStart doesn't interfere with runHotPath tests.
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(() => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("positive: complexity=low, sprint ships → success=true, shipped=true, sprintsRun=1", async () => {
    const flowDir = await tmpFlowDir();

    (runSprint as any).mockImplementationOnce(async function* () {
      yield { type: "content", content: "sprint 1 running" };
      return shippedIter(1);
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir })));

    expect(result.success).toBe(true);
    expect(result.shipped).toBe(true);
    expect(result.sprintsRun).toBe(1);
  });

  it("positive: exactly 1 sprint called regardless of maxSprints flag", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementation(async function* () {
      return shippedIter(1);
    });

    await drain(runProductLoop(makeOpts({ flowDir, flags: { maxCost: 50, maxSprints: 5, doneThreshold: 0.9 } })));

    // runSprint must have been called exactly once on the hot-path.
    expect(runSprint).toHaveBeenCalledTimes(1);
  });

  it("positive: extractRunToEE is called after shipped sprint", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter(1);
    });

    await drain(runProductLoop(makeOpts({ flowDir, cwd: flowDir })));

    expect(extractRunToEE).toHaveBeenCalledTimes(1);
  });

  it("negative: sprint returns retrospective → result halted, NO retry (runSprint called once)", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return retrospectiveIter(1);
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir })));

    expect(result.success).toBe(false);
    expect(result.stage).toBe("halted");
    // Critically: runSprint is called exactly once — no retry loop.
    expect(runSprint).toHaveBeenCalledTimes(1);
  });

  it("negative: sprint throws (CB halt) → result halted, sprintsRun=0", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      throw new Error("Halted by circuit breaker: cost projection 99 exceeds headroom 1");
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir })));

    expect(result.success).toBe(false);
    expect(result.stage).toBe("halted");
    expect(result.sprintsRun).toBe(0);
  });
});
