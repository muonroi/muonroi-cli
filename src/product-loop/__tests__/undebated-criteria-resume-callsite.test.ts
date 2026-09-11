/**
 * F8b — RESUME CALL-SITE PIN.
 *
 * The F8 gate was correct and wired to the one transition a `/ideal resume`
 * never takes. Measured 2026-09-10, two consecutive resumes:
 *
 *   02:38:04  sprint_stage  {sprintIndex:1, stage:"planning"}
 *   02:38:04  sprint_stage  {sprintIndex:1, stage:"implementation"}
 *   …
 *   03:04:31  sprint_stage  {sprintIndex:2, stage:"judgment"}
 *
 * Zero `phase_start`, zero `council_message`: research→scoping — where the gate
 * sat — was never entered, so the gate could not fire on the path that schedules
 * the sprints. `undebated-criteria-record.test.ts` proves the helper; this file
 * drives the REAL `runProductLoop({subcommand:"resume"})` and asserts the gate
 * is consulted before `runSprint` is ever reached, on both the
 * phase-orchestrated and the legacy sprint entry.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { CouncilStanceRow } from "../../types/index.js";

vi.mock("../loop-driver.js", () => ({
  // biome-ignore lint/correctness/useYield: intentional mock generator
  runLoopDriver: vi.fn(async function* () {
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));
vi.mock("../sprint-runner.js", () => ({ runSprint: vi.fn() }));
vi.mock("../../ee/phase-outcome.js", () => ({ fireAndForgetPhaseOutcome: vi.fn() }));

import { createRun } from "../../flow/run-manager.js";
import { writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { runSprint } from "../sprint-runner.js";
import {
  UNDEBATED_OPTION_ACCEPT,
  UNDEBATED_OPTION_COUNCIL,
  UNDEBATED_OPTION_NARROW,
  writeUndebatedStanceRecord,
} from "../undebated-criteria-gate.js";

const NUGET = "Bộ analyzer có thể được đóng gói thành NuGet package TCIS.CodeStandards.Analyzers";
const VS_WARNING = "Visual Studio hiển thị warning khi parameter không đúng chuẩn";
const ROSTER = ["architect", "engineer"];

function stanceRow(criterion: string, met: boolean, marks: Array<"+" | "-" | "~" | null>): CouncilStanceRow {
  const stances: CouncilStanceRow["stances"] = {};
  ROSTER.forEach((r, i) => {
    stances[r] = marks[i] ?? null;
  });
  return { criterion, met, stances };
}

const ARGUED = stanceRow(VS_WARNING, false, ["+", "-"]);
const SILENT = stanceRow(NUGET, false, [null, null]);

beforeAll(async () => {
  await loadCatalog();
});

let flowDir: string;
let phaseModeBefore: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  phaseModeBefore = process.env.MUONROI_PHASE_MODE;
  flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "f8b-resume-"));
  // A sprint that is somehow reached returns a benign shipped iteration, so a
  // gate that failed to stop the run shows up as "runSprint was called", never
  // as an unrelated crash.
  (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    // biome-ignore lint/correctness/useYield: intentional mock generator
    async function* () {
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
      };
    },
  );
});

afterEach(async () => {
  if (phaseModeBefore === undefined) delete process.env.MUONROI_PHASE_MODE;
  else process.env.MUONROI_PHASE_MODE = phaseModeBefore;
  await fs.rm(flowDir, { recursive: true, force: true }).catch(() => {
    /* temp dir cleanup is best-effort */
  });
});

/** A run in exactly the shape `/ideal resume <runId>` picks up: resumable, sprints ahead. */
async function seedResumableRun(stanceRows: CouncilStanceRow[] | null): Promise<string> {
  const run = await createRun(flowDir);
  await writeManifest(flowDir, run.id, {
    idea: "Chuẩn hoá code style cho TCIS",
    maxSprints: 3,
    doneThreshold: 0.9,
    createdAt: new Date("2026-09-10T02:00:00.000Z"),
  });
  if (stanceRows) {
    await writeUndebatedStanceRecord(path.join(flowDir, "runs", run.id), stanceRows);
  }
  return run.id;
}

function makeOpts(runId: string, answer: string | null): any {
  return {
    flowDir,
    runId,
    subcommand: "resume",
    sessionModelId: getTestModels().balanced,
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9 },
    respondToQuestion:
      answer === null ? vi.fn(() => new Promise<string>(() => {})) : vi.fn(async () => answer as string),
    respondToPreflight: vi.fn(async () => true),
  };
}

async function drain(gen: AsyncGenerator<any, any, unknown>): Promise<{ chunks: any[]; result: any }> {
  const chunks: any[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value };
    chunks.push(value);
  }
}

describe("/ideal resume consults the undebated-criteria gate before any sprint work", () => {
  it("phase-orchestrated resume: an all-null criterion HALTS before runSprint", async () => {
    delete process.env.MUONROI_PHASE_MODE; // default path — phase orchestrator ON
    process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS = "20";
    try {
      const runId = await seedResumableRun([ARGUED, SILENT]);
      const opts = makeOpts(runId, null); // unattended — nobody answers
      const { chunks, result } = await drain(runProductLoop(opts));

      expect(result.stage).toBe("halted");
      expect(result.reason).toBe("undebated_criteria");
      expect(runSprint).not.toHaveBeenCalled();
      // The card was shown on the askcard surface, naming the criterion.
      const card = chunks.find((c) => c.type === "council_question");
      expect(card?.councilQuestion?.context).toContain(NUGET);
      expect(chunks.map((c) => c.content ?? "").join("")).toContain(NUGET);
    } finally {
      delete process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS;
    }
  });

  it("legacy sprint loop (MUONROI_PHASE_MODE=0): same halt, same evidence", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS = "20";
    try {
      const runId = await seedResumableRun([ARGUED, SILENT]);
      const { result } = await drain(runProductLoop(makeOpts(runId, null)));

      expect(result.stage).toBe("halted");
      expect(result.reason).toBe("undebated_criteria");
      expect(runSprint).not.toHaveBeenCalled();
    } finally {
      delete process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS;
    }
  });

  it("a human who answers 'take it back to the council' stops the resume", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun([ARGUED, SILENT]);
    const opts = makeOpts(runId, UNDEBATED_OPTION_COUNCIL);
    const { result } = await drain(runProductLoop(opts));

    expect(result.reason).toBe("undebated_criteria");
    expect(runSprint).not.toHaveBeenCalled();
    expect(opts.respondToQuestion).toHaveBeenCalledTimes(1);
  });

  it("a human who accepts is not asked AGAIN on the next resume — the answer is honoured", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun([ARGUED, SILENT]);

    const first = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    await drain(runProductLoop(first));
    expect(first.respondToQuestion).toHaveBeenCalledTimes(1);
    expect(runSprint).toHaveBeenCalled();

    vi.clearAllMocks();
    const second = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    const { chunks, result } = await drain(runProductLoop(second));

    expect(second.respondToQuestion).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "council_question")).toBe(false);
    expect(chunks.map((c) => c.content ?? "").join("")).toContain("honouring the answer already given");
    expect(result.reason).not.toBe("undebated_criteria");
    expect(runSprint).toHaveBeenCalled();
  });

  it("a prior 'narrow' is honoured too — no card, no re-ask", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun([ARGUED, SILENT]);
    await drain(runProductLoop(makeOpts(runId, UNDEBATED_OPTION_NARROW)));

    vi.clearAllMocks();
    const second = makeOpts(runId, UNDEBATED_OPTION_NARROW);
    const { chunks } = await drain(runProductLoop(second));
    expect(second.respondToQuestion).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "council_question")).toBe(false);
    expect(runSprint).toHaveBeenCalled();
  });

  it("a prior 'take it back to the council' keeps stopping later resumes, without re-asking", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun([ARGUED, SILENT]);
    await drain(runProductLoop(makeOpts(runId, UNDEBATED_OPTION_COUNCIL)));

    vi.clearAllMocks();
    const second = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    const { result } = await drain(runProductLoop(second));
    expect(second.respondToQuestion).not.toHaveBeenCalled();
    expect(result.reason).toBe("undebated_criteria");
    expect(runSprint).not.toHaveBeenCalled();
  });

  it("an ARGUED-but-unmet criterion does NOT stop a resume — the gate is not a tax", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun([ARGUED, stanceRow(NUGET, false, ["-", "~"])]);
    const opts = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    const { chunks, result } = await drain(runProductLoop(opts));

    expect(opts.respondToQuestion).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "council_question")).toBe(false);
    expect(result.reason).not.toBe("undebated_criteria");
    expect(runSprint).toHaveBeenCalled();
  });

  it("a run with NO stance record resumes untouched — missing evidence is not silence", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    const runId = await seedResumableRun(null);
    const opts = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    const { result } = await drain(runProductLoop(opts));

    expect(opts.respondToQuestion).not.toHaveBeenCalled();
    expect(result.reason).not.toBe("undebated_criteria");
    expect(runSprint).toHaveBeenCalled();
  });

  it("an unattended timeout is NOT recorded — the next attended resume still gets asked", async () => {
    process.env.MUONROI_PHASE_MODE = "0";
    process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS = "20";
    let runId: string;
    try {
      runId = await seedResumableRun([ARGUED, SILENT]);
      await drain(runProductLoop(makeOpts(runId, null)));
    } finally {
      delete process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS;
    }

    vi.clearAllMocks();
    const second = makeOpts(runId, UNDEBATED_OPTION_ACCEPT);
    await drain(runProductLoop(second));
    expect(second.respondToQuestion).toHaveBeenCalledTimes(1);
    expect(runSprint).toHaveBeenCalled();
  });
});
