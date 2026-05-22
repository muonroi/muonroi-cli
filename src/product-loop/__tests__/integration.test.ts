/**
 * Integration tests for runProductLoop subcommands (start/status/resume/abort/ship).
 * Heavy mocking: loop-driver and sprint-runner are stubbed so the test focuses
 * on the index.ts orchestration glue (manifest writes, phase transitions,
 * run discovery, crashed-sprint detection).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(async function* () {
    yield { type: "content", content: "[gather→research→scoping]" };
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

import { fireAndForgetPhaseOutcome } from "../../ee/phase-outcome.js";
import { readIterations, readManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

async function tmpFlowDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ideal-int-"));
  return dir;
}

function makeOpts(overrides: any = {}): any {
  return {
    flowDir: overrides.flowDir,
    sessionModelId: getTestModels().balanced,
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9 },
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

describe("runProductLoop integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep existing tests on the legacy flat-sprint path so they don't
    // require the full phase-orchestrator stack (phase plans, project context, etc.).
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(() => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("start: creates 6 artifact files and runs 1 sprint to shipped", async () => {
    const flowDir = await tmpFlowDir();

    (runSprint as any).mockImplementationOnce(async function* () {
      yield { type: "content", content: "sprint 1 running" };
      const iter: IterationState = {
        sprintN: 1,
        stage: "shipped",
        scoreBefore: 0,
        scoreAfter: 1.0,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0.5,
        lastVerifyResult: "PASS",
        actualCost: 0.5,
        score: 1.0,
      };
      return iter;
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, idea: "build a markdown todo CLI" })));

    expect(result.success).toBe(true);
    expect(result.shipped).toBe(true);
    expect(result.sprintsRun).toBe(1);

    // All 6 artifact files exist on disk in the run directory.
    const runId = result.runId;
    const runDir = path.join(flowDir, "runs", runId);
    const files = await fs.readdir(runDir);
    for (const f of ["roadmap.md", "state.md", "delegations.md", "gray-areas.md", "iterations.md", "manifest.md"]) {
      expect(files).toContain(f);
    }

    const manifest = await readManifest(flowDir, runId);
    expect(manifest?.idea).toBe("build a markdown todo CLI");
    expect(manifest?.doneAt).toBeDefined();
    expect(manifest?.verdict?.pass).toBe(true);
  });

  it("start: halted run when sprint-runner throws (CB)", async () => {
    const flowDir = await tmpFlowDir();
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      throw new Error("Halted by circuit breaker: cost projection 99 exceeds headroom 1");
    });

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, idea: "ship product X" })));
    expect(result.success).toBe(false);
    expect(result.stage).toBe("halted");
    expect(result.reason).toMatch(/cost projection/);
  });

  it("status: lists active runs", async () => {
    const flowDir = await tmpFlowDir();
    // Create two runs by invoking start twice with quick-pass sprints.
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementation(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "shipped",
        scoreBefore: 0,
        scoreAfter: 1.0,
        criteriaMet: 1,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    await drain(runProductLoop(makeOpts({ flowDir, idea: "first idea" })));
    await drain(runProductLoop(makeOpts({ flowDir, idea: "second idea" })));

    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain("Active runs");
    expect(text).toContain("first idea");
    expect(text).toContain("second idea");
  });

  it("abort: marks manifest aborted=true and fires phase-outcome=aborted", async () => {
    const flowDir = await tmpFlowDir();
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "shipped",
        scoreBefore: 0,
        scoreAfter: 1,
        criteriaMet: 1,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const startResult = await drain(runProductLoop(makeOpts({ flowDir, idea: "to abort" })));
    const runId = (startResult.result as any).runId;

    const abortRes = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "abort", runId })));
    expect(abortRes.result.reason).toBe("aborted");

    const manifest = await readManifest(flowDir, runId);
    expect(manifest?.aborted).toBe(true);
    expect(fireAndForgetPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: runId, outcome: "aborted" }),
    );
  });

  it("ship: refuses when last verify is not PASS", async () => {
    const flowDir = await tmpFlowDir();
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "retrospective",
        scoreBefore: 0,
        scoreAfter: 0.4,
        criteriaMet: 0,
        criteriaPartial: 0,
        criteriaUnmet: 3,
        costUsd: 0,
        lastVerifyResult: "FAIL",
      };
      return iter;
    });
    const start = await drain(runProductLoop(makeOpts({ flowDir, idea: "x" })));
    const runId = (start.result as any).runId;
    // After max-sprints with non-shipped, run is halted but iterations need
    // to be persisted by us since the sprint-runner mock does not call appendIteration.
    const { appendIteration } = await import("../artifact-io.js");
    await appendIteration(flowDir, runId, {
      sprintN: 1,
      stage: "retrospective",
      scoreBefore: 0,
      scoreAfter: 0.4,
      criteriaMet: 0,
      criteriaPartial: 0,
      criteriaUnmet: 3,
      costUsd: 0,
      lastVerifyResult: "FAIL",
    });
    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "ship", runId })));
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain("not ready to ship");
  });

  it("ship: forces final approval when last verify=PASS", async () => {
    const flowDir = await tmpFlowDir();
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "retrospective",
        scoreBefore: 0,
        scoreAfter: 0.85,
        criteriaMet: 2,
        criteriaPartial: 1,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const start = await drain(
      runProductLoop(makeOpts({ flowDir, idea: "x", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.9 } })),
    );
    const runId = (start.result as any).runId;
    // Persist a passing iteration so ship can read it back.
    const { appendIteration } = await import("../artifact-io.js");
    await appendIteration(flowDir, runId, {
      sprintN: 1,
      stage: "retrospective",
      scoreBefore: 0,
      scoreAfter: 0.85,
      criteriaMet: 2,
      criteriaPartial: 1,
      criteriaUnmet: 0,
      costUsd: 0,
      lastVerifyResult: "PASS",
    });

    const respondToPreflight = vi.fn(async () => true);
    const { result } = await drain(
      runProductLoop(makeOpts({ flowDir, subcommand: "ship", runId, respondToPreflight })),
    );
    expect(result.shipped).toBe(true);
    expect(respondToPreflight).toHaveBeenCalledWith("ship-final");

    const manifest = await readManifest(flowDir, runId);
    expect(manifest?.verdict?.pass).toBe(true);
  });

  it("resume: detects crashed sprint and re-enters cleanly", async () => {
    const flowDir = await tmpFlowDir();
    // First run a sprint that ships to seed the manifest + iterations.md.
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "retrospective",
        scoreBefore: 0,
        scoreAfter: 0.5,
        criteriaMet: 1,
        criteriaPartial: 1,
        criteriaUnmet: 1,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const start = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "to resume", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const runId = (start.result as any).runId;
    expect(start.result.success).toBe(false); // halted at max-sprints

    // Now simulate a crashed in-flight sprint by writing one with UNKNOWN verify.
    const { appendIteration } = await import("../artifact-io.js");
    await appendIteration(flowDir, runId, {
      sprintN: 2,
      stage: "in_flight",
      scoreBefore: 0.5,
      scoreAfter: 0,
      criteriaMet: 1,
      criteriaPartial: 1,
      criteriaUnmet: 1,
      costUsd: 0,
      lastVerifyResult: "UNKNOWN",
    });

    // Resume should detect the crashed sprint, mark it, and try again.
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 3,
        stage: "shipped",
        scoreBefore: 0.5,
        scoreAfter: 1.0,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });

    const { chunks, result } = await drain(
      runProductLoop(
        makeOpts({ flowDir, subcommand: "resume", runId, flags: { maxCost: 50, maxSprints: 5, doneThreshold: 0.9 } }),
      ),
    );
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain("Detected crashed sprint");
    expect(result.shipped).toBe(true);

    // The crashed sprint must be flagged in iterations.md.
    const iters = await readIterations(flowDir, runId);
    const crashed = iters.find((i) => i.sprintN === 2);
    expect(crashed?.crashed).toBe(true);

    // EE phase-outcome=resumed must have been fired.
    expect(fireAndForgetPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "resumed", sessionId: runId }),
    );
  });
});
