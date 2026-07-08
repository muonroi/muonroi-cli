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

import { buildDebateCheckpoint, writeDebateCheckpoint } from "../../council/debate-checkpoint.js";
import { fireAndForgetPhaseOutcome } from "../../ee/phase-outcome.js";
import { readIterations, readManifest, writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
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

  // ── B: auto-detect the newest incomplete run when resume/abort gets no runId ──

  it("resume (no runId): auto-detects the newest incomplete run", async () => {
    const flowDir = await tmpFlowDir();
    // Sprint stub that always halts at max-sprints so runs stay incomplete
    // (no doneAt, not aborted).
    const haltingSprint = async function* () {
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
    };

    // Two incomplete runs, older then newer.
    (runSprint as any).mockImplementationOnce(haltingSprint);
    const older = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "older idea", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const olderId = (older.result as any).runId;
    // Ensure a strictly-later createdAt on the newer run (manifest sorts by createdAt).
    await new Promise((r) => setTimeout(r, 5));
    (runSprint as any).mockImplementationOnce(haltingSprint);
    const newer = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "newer idea", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const newerId = (newer.result as any).runId;
    expect(newerId).not.toBe(olderId);

    // Bare resume (no runId) should pick the newer run.
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 2,
        stage: "shipped",
        scoreBefore: 0.4,
        scoreAfter: 1,
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
        makeOpts({ flowDir, subcommand: "resume", flags: { maxCost: 50, maxSprints: 5, doneThreshold: 0.9 } }),
      ),
    );
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain(`Resuming latest incomplete run ${newerId}`);
    expect((result as any).runId).toBe(newerId);
  });

  it("resume (no runId): reports when there is no incomplete run", async () => {
    const flowDir = await tmpFlowDir();
    const { chunks, result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume" })));
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain("No incomplete run to resume");
    expect(result.reason).toBe("no_incomplete_run");
  });

  it("resume (no runId): skips aborted + shipped runs", async () => {
    const flowDir = await tmpFlowDir();
    // Run 1 → abort it (terminal). Run 2 → leave incomplete.
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
    const r1 = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "will abort", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const abortedId = (r1.result as any).runId;
    await drain(runProductLoop(makeOpts({ flowDir, subcommand: "abort", runId: abortedId })));

    await new Promise((r) => setTimeout(r, 5));
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
    const r2 = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "still open", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const openId = (r2.result as any).runId;

    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 2,
        stage: "shipped",
        scoreBefore: 0.4,
        scoreAfter: 1,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const { chunks } = await drain(
      runProductLoop(
        makeOpts({ flowDir, subcommand: "resume", flags: { maxCost: 50, maxSprints: 5, doneThreshold: 0.9 } }),
      ),
    );
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain(`Resuming latest incomplete run ${openId}`);
    expect(text).not.toContain(abortedId);
  });

  // ── C-v2: cross-session resume of an interrupted council debate ──────────────

  it("resume: re-enters the council FSM when a debate checkpoint is present", async () => {
    const flowDir = await tmpFlowDir();
    const runId = "cv2-interrupted";
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    await writeManifest(flowDir, runId, {
      idea: "resume the interrupted debate",
      capUsd: 50,
      maxSprints: 3,
      doneThreshold: 0.9,
      createdAt: new Date(),
    });
    // Simulate a debate that was interrupted after 2 of 3 rounds.
    await writeDebateCheckpoint(
      runDir,
      buildDebateCheckpoint({
        problemStatement: "resume the interrupted debate",
        roundCount: 2,
        maxRounds: 3,
        exchangeLogs: new Map([["a<>b", ["turn-1", "turn-2"]]]),
        runningSummary: "partial",
        researchFindings: "found",
        active: [{ role: "architect" as any, model: "m1", position: "p", stance: { name: "a", lens: "l" } }],
        archive: [],
        lastCriteriaMet: [],
        bestCriteriaMetCount: 0,
        roundsSinceProgress: 0,
        savedAt: "2026-07-07T00:00:00.000Z",
      }),
    );

    // The mocked runLoopDriver (module factory) returns an approved spec.
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "shipped",
        scoreBefore: 0,
        scoreAfter: 1,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });

    const { chunks } = await drain(
      runProductLoop(
        makeOpts({ flowDir, subcommand: "resume", runId, flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9 } }),
      ),
    );

    // The C-v2 branch fired: it surfaced the interrupted-debate notice and
    // re-entered the council FSM (loop-driver) before sprints.
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain("interrupted council debate");
    expect(runLoopDriver).toHaveBeenCalled();
  });

  it("resume: does NOT re-enter the FSM when there is no debate checkpoint", async () => {
    const flowDir = await tmpFlowDir();
    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 1,
        stage: "shipped",
        scoreBefore: 0,
        scoreAfter: 1,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const start = await drain(runProductLoop(makeOpts({ flowDir, idea: "no interrupted debate" })));
    const runId = (start.result as any).runId;
    (runLoopDriver as any).mockClear();

    (runSprint as any).mockImplementationOnce(async function* () {
      const iter: IterationState = {
        sprintN: 2,
        stage: "shipped",
        scoreBefore: 1,
        scoreAfter: 1,
        criteriaMet: 3,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      };
      return iter;
    });
    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId })));
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).not.toContain("interrupted council debate");
    expect(runLoopDriver).not.toHaveBeenCalled();
  });

  it("abort (no runId): auto-detects and aborts the newest incomplete run", async () => {
    const flowDir = await tmpFlowDir();
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
    const start = await drain(
      runProductLoop(
        makeOpts({ flowDir, idea: "to auto-abort", flags: { maxCost: 50, maxSprints: 1, doneThreshold: 0.95 } }),
      ),
    );
    const runId = (start.result as any).runId;

    const abortRes = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "abort" })));
    expect(abortRes.result.reason).toBe("aborted");
    expect((abortRes.result as any).runId).toBe(runId);
    const manifest = await readManifest(flowDir, runId);
    expect(manifest?.aborted).toBe(true);
  });
});
