/**
 * Defect 1, consequence half — a run that failed must stay resumable.
 *
 * `findLatestIncompleteRun` (index.ts) skips any manifest carrying `doneAt`.
 * The old finalize stamped `doneAt` alongside the hardcoded
 * `{pass:true, score:1}` verdict on every path the phase orchestrator
 * returned from, so a run cut short declared itself complete and could never be
 * resumed again — by a user, or by itself. Observed on run mtpd7mf19b10:
 * `/ideal resume` answered `no_incomplete_run` while the run's own resume digest
 * read "Next action: Retry sprint 1: engineering_floor".
 *
 * These tests pin the resume consequence of the two manifest shapes:
 * how the OLD code wrote a failed run, and how the NEW code writes one.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(async function* () {
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));
vi.mock("../sprint-runner.js", () => ({ runSprint: vi.fn() }));
vi.mock("../../ee/phase-outcome.js", () => ({ fireAndForgetPhaseOutcome: vi.fn() }));

import { createRun } from "../../flow/run-manager.js";
import { writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { deriveRunVerdict, runIsTerminal } from "../run-verdict.js";

beforeAll(async () => {
  await loadCatalog();
});

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "run-verdict-resume-"));
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

/** Seeds one run whose sprints all failed, written the way `finalize` chooses. */
async function seedFailedRun(flowDir: string, stampDoneAt: boolean): Promise<string> {
  const run = await createRun(flowDir);
  const verdict = deriveRunVerdict({
    outcomes: [
      {
        sprintN: 1,
        pass: false,
        score: 0,
        verify: "UNKNOWN",
        failedCondition: "engineering_floor",
        criteriaMet: 0,
        criteriaPartial: 0,
        criteriaUnmet: 1,
        finishedAt: "2026-09-06T05:55:56.837Z",
      },
    ],
    phasesPassed: true,
  });
  expect(verdict.pass).toBe(false);
  await writeManifest(flowDir, run.id, {
    idea: "make the headless exit code tell the truth",
    capUsd: 50,
    maxSprints: 8,
    doneThreshold: 0.9,
    createdAt: new Date("2026-09-06T05:22:22.917Z"),
    ...(stampDoneAt ? { doneAt: new Date("2026-09-06T05:56:11.706Z") } : {}),
    verdict,
  });
  return run.id;
}

describe("a failed run stays resumable", () => {
  it("OLD shape (doneAt stamped on a failed run) is unresumable — the defect", async () => {
    const flowDir = await tmpFlowDir();
    await seedFailedRun(flowDir, /* stampDoneAt */ true);

    const { result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume" })));
    expect(result.reason).toBe("no_incomplete_run");
  });

  it("NEW shape (no doneAt on a failed run) is found by resume", async () => {
    const flowDir = await tmpFlowDir();
    const runId = await seedFailedRun(flowDir, /* stampDoneAt */ false);

    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume" })));
    const text = chunks.map((c: any) => c.content ?? "").join("");
    expect(text).toContain(`Resuming latest incomplete run ${runId}`);
    expect(text).not.toContain("No incomplete run to resume");
  });

  it("runIsTerminal is what gates doneAt, and it refuses a failed verdict", () => {
    const failed = deriveRunVerdict({
      outcomes: [
        {
          sprintN: 1,
          pass: false,
          score: 0,
          verify: "UNKNOWN",
          failedCondition: "engineering_floor",
          criteriaMet: 0,
          criteriaPartial: 0,
          criteriaUnmet: 1,
          finishedAt: "2026-09-06T05:55:56.837Z",
        },
      ],
      phasesPassed: true,
    });
    expect(runIsTerminal(failed)).toBe(false);
  });
});
