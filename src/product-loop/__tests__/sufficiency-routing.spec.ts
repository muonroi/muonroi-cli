/**
 * Sufficiency-gate routing tests.
 *
 * Asserts the dispatcher invariants for the inverted router:
 *  - sufficiencyMissing non-empty  → runLoopDriver IS called (Council forced),
 *    EVEN when complexity is "low" and forceCouncil is unset.
 *  - sufficiencyMissing empty/undefined + complexity="low" → hot-path (existing).
 *
 * Mirrors the mocking strategy of complexity-routing.spec.ts so the FSM driver
 * isn't actually exercised — only the dispatcher decision is under test.
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
  return fs.mkdtemp(path.join(os.tmpdir(), "suff-route-"));
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    flowDir: overrides.flowDir as string,
    idea: overrides.idea ?? "todo app",
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

describe("sufficiency routing — vague briefs force Council", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(() => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("sufficiencyMissing=['scope'] + complexity=low → Council forced (not hot-path)", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          complexity: "low",
          sufficiencyMissing: ["scope"],
        }),
      ),
    );

    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("sufficiencyMissing=['scope','intent'] (todo app) + complexity=low → Council forced", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          idea: "todo app",
          complexity: "low",
          sufficiencyMissing: ["scope", "intent"],
        }),
      ),
    );

    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("sufficiencyMissing=[] + complexity=low → hot-path (existing behavior)", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          complexity: "low",
          sufficiencyMissing: [],
        }),
      ),
    );

    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("sufficiencyMissing undefined + complexity=low → hot-path (legacy callers unaffected)", async () => {
    const flowDir = await tmpFlowDir();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          complexity: "low",
          // sufficiencyMissing intentionally omitted
        }),
      ),
    );

    expect(runLoopDriver).not.toHaveBeenCalled();
  });
});
