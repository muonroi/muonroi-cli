/**
 * Defect 1, wiring half — exercises the REAL finalize block in
 * `runPhasesPath` (src/product-loop/index.ts), which is the code that wrote
 * `verdict: {pass:true, score:1, reason:"phases_complete"}` as a literal.
 *
 * This path is default-ON in production (`MUONROI_PHASE_MODE !== "0"`) but every
 * pre-existing integration test forces it OFF, which is why the hardcoded
 * verdict survived. These tests drive it ON.
 *
 * `runPhases` is mocked to return its outcome directly, so the assertion is
 * purely about how the run-level verdict is derived from the sprint outcomes on
 * disk — not about the phase orchestrator itself.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

const phasesOutcome: { pass: boolean; reason?: string } = { pass: true };

vi.mock("../phase-runner.js", () => ({
  runPhases: vi.fn(async function* () {
    return phasesOutcome;
  }),
}));
vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(async function* () {
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));
vi.mock("../sprint-runner.js", () => ({ runSprint: vi.fn() }));
vi.mock("../../ee/phase-outcome.js", () => ({ fireAndForgetPhaseOutcome: vi.fn() }));
vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 0 })),
  composeRunTranscript: vi.fn(async () => ""),
}));
// index.ts `chatEnvConfig` reaches for this via CJS require(), which vitest's
// ESM loader cannot resolve; chat is irrelevant to the verdict under test.
vi.mock("../../chat/factory.js", () => ({ readChatProvider: () => null }));

import { writeSprintOutcome } from "../../flow/run-artifacts.js";
import { createRun } from "../../flow/run-manager.js";
import { readManifest, writeManifest } from "../artifact-io.js";
import { writeProjectContext } from "../discovery-persistence.js";
import { runProductLoop } from "../index.js";

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  vi.clearAllMocks();
  phasesOutcome.pass = true;
  phasesOutcome.reason = undefined;
  delete process.env.MUONROI_PHASE_MODE; // phase path ON — production default
});

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "run-verdict-final-"));
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
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

/** Seeds a run with the prerequisites `runPhasesPath` needs, plus sprint outcomes. */
async function seedRun(
  flowDir: string,
  outcomes: Array<{ sprintN: number; pass: boolean; score: number; failedCondition?: string; finishedAt: string }>,
): Promise<string> {
  const run = await createRun(flowDir);
  await writeManifest(flowDir, run.id, {
    idea: "make the headless exit code tell the truth",
    capUsd: 50,
    maxSprints: 8,
    doneThreshold: 0.9,
    createdAt: new Date("2026-09-06T05:22:22.917Z"),
  });
  await writeProjectContext(flowDir, run.id, {
    version: 1,
    schemaName: "project-context",
    generatedAt: new Date().toISOString(),
    idea: "make the headless exit code tell the truth",
    detection: {},
    context: { backendStack: { language: "TypeScript", framework: "react" } },
    recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: true } },
    userOverrides: [],
  } as any);
  for (const o of outcomes) {
    await writeSprintOutcome(flowDir, run.id, {
      verify: o.pass ? "PASS" : "UNKNOWN",
      criteriaMet: o.pass ? 1 : 0,
      criteriaPartial: 0,
      criteriaUnmet: o.pass ? 0 : 1,
      ...o,
    });
  }
  return run.id;
}

describe("runPhasesPath finalize — the run verdict is derived, not asserted", () => {
  it("does NOT write pass/1 when every recorded sprint failed its engineering floor", async () => {
    const flowDir = await tmpFlowDir();
    // The exact outcomes run mtpd7mf19b10 recorded.
    const runId = await seedRun(flowDir, [
      { sprintN: 1, pass: false, score: 0, failedCondition: "engineering_floor", finishedAt: "2026-09-06T05:55:56.837Z" },
      { sprintN: 2, pass: false, score: 0, failedCondition: "engineering_floor", finishedAt: "2026-09-06T05:54:46.832Z" },
    ]);

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId })));

    const m = await readManifest(flowDir, runId);
    expect(m?.verdict?.pass).toBe(false);
    expect(m?.verdict?.score).not.toBe(1);
    expect(m?.verdict?.failedCondition).toBe("engineering_floor");
    // …and the run must remain resumable.
    expect(m?.doneAt).toBeUndefined();
    expect(result.success).toBe(false);
  });

  it("refuses to pass a run that recorded no sprint outcomes at all", async () => {
    const flowDir = await tmpFlowDir();
    const runId = await seedRun(flowDir, []);

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId })));

    const m = await readManifest(flowDir, runId);
    expect(m?.verdict?.pass).toBe(false);
    expect(m?.verdict?.reason).toBe("no_sprint_outcomes");
    expect(m?.doneAt).toBeUndefined();
    expect(result.success).toBe(false);
  });

  it("writes pass + stamps doneAt when the latest sprint genuinely passed", async () => {
    const flowDir = await tmpFlowDir();
    const runId = await seedRun(flowDir, [
      { sprintN: 1, pass: true, score: 0.95, finishedAt: "2026-09-06T05:55:56.837Z" },
    ]);

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId })));

    const m = await readManifest(flowDir, runId);
    expect(m?.verdict?.pass).toBe(true);
    expect(m?.verdict?.score).toBe(0.95);
    expect(m?.doneAt).toBeDefined();
    expect(result.success).toBe(true);
  });
});
