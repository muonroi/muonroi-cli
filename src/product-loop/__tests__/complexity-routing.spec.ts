/**
 * Integration tests for complexity-based routing in runProductLoop (P2.6).
 *
 * Verifies:
 *  - complexity="low" + forceCouncil unset  → hot-path (runLoopDriver NOT called)
 *  - complexity="low" + forceCouncil=true   → full path (runLoopDriver called)
 *  - complexity="medium"                    → full path (runLoopDriver called)
 *  - complexity="high"                      → full path (runLoopDriver called)
 *  - complexity undefined                   → full path (runLoopDriver called)
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(async function* () {
    yield { type: "content", content: "[gather→research→scoping]" };
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));

vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 1, mistakes: 0, stored: 1 })),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "routing-"));
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    flowDir: overrides.flowDir as string,
    idea: overrides.idea ?? "build a counter",
    subcommand: "start",
    sessionModelId: "claude-sonnet-4-6",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9, ...((overrides.flags as any) ?? {}) },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
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

function shippedIter(): IterationState {
  return {
    sprintN: 1,
    stage: "shipped",
    scoreBefore: 0,
    scoreAfter: 1.0,
    criteriaMet: 3,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0,
    lastVerifyResult: "PASS",
  };
}

describe("complexity routing — P2.6", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(() => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("complexity=low, no forceCouncil → hot-path: runLoopDriver NOT called", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, complexity: "low" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("complexity=low + forceCouncil=true → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          complexity: "low",
          flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9, forceCouncil: true },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("complexity=medium → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, complexity: "medium" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("complexity=high → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, complexity: "high" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("complexity=undefined (not provided) → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir }))); // no complexity field

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });
});
