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

/** Empty directory — passes the existing-repo-bypass check (greenfield). */
async function tmpEmptyCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "routing-cwd-"));
}

/** Existing-project directory — has a package.json so detection classifies it. */
async function tmpExistingCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-existing-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fake-existing",
      dependencies: { react: "1", vite: "1", ai: "1", vitest: "1", lodash: "1", zod: "1" },
    }),
  );
  // Need >5 source files for classify() to mark as "existing" (else "ambiguous").
  for (let i = 0; i < 10; i++) {
    await fs.writeFile(path.join(dir, `src${i}.ts`), "export {};");
  }
  return dir;
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    flowDir: overrides.flowDir as string,
    cwd: overrides.cwd, // when undefined, dispatcher falls back to process.cwd()
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
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd, complexity: "low" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("complexity=low + forceCouncil=true → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          cwd,
          complexity: "low",
          flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9, forceCouncil: true },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("greenfield complexity=medium → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd, complexity: "medium" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("greenfield complexity=high → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd, complexity: "high" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("greenfield complexity=undefined → full path: runLoopDriver called", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C1 — existing-repo bypass
// ---------------------------------------------------------------------------

describe("C1 existing-repo bypass — Sprint C", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(() => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("existing repo + complexity=medium → hot-path (no full Council)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd, complexity: "medium" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("existing repo + sufficiency gaps → hot-path (gaps no longer force Council)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          cwd,
          complexity: "medium",
          sufficiencyMissing: ["scope", "target"],
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("existing repo + complexity=medium + needsClarification → full Council (underspecified earns interview)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(makeOpts({ flowDir, cwd, complexity: "medium", needsClarification: true })),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("existing repo + complexity=low + needsClarification → hot-path (a quick task never earns an interview)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(makeOpts({ flowDir, cwd, complexity: "low", needsClarification: true })),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("existing repo + complexity=high → still full Council (architectural change)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, cwd, complexity: "high" })));

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("existing repo + forceCouncil=true → full Council (explicit opt-in wins)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpExistingCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          cwd,
          complexity: "medium",
          flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9, forceCouncil: true },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("greenfield + sufficiency gaps → STILL forces Council (no bypass)", async () => {
    const flowDir = await tmpFlowDir();
    const cwd = await tmpEmptyCwd();

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const { result } = await drain(
      runProductLoop(
        makeOpts({
          flowDir,
          cwd,
          complexity: "low", // would normally hot-path
          sufficiencyMissing: ["scope"],
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(runLoopDriver).toHaveBeenCalled();
  });
});
