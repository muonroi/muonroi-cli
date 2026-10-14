/**
 * F8b — the gate's evidence and its answer must survive the process.
 *
 * `undebated-criteria-gate.test.ts` covers the discrimination (all-null row vs
 * argued vs empty roster). This file covers the half that was missing entirely:
 * the debate's stance record was in RAM only, so `/ideal resume` — which never
 * re-enters research→scoping — had nothing to judge and could not fire the gate
 * on the path that actually schedules sprints.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilStanceRow, StreamChunk } from "../../types/index.js";
import {
  enforceUndebatedCriteriaGate,
  findUndebatedCriteria,
  readUndebatedGateRecord,
  recordUndebatedResolution,
  UNDEBATED_OPTION_ACCEPT,
  UNDEBATED_OPTION_COUNCIL,
  UNDEBATED_OPTION_NARROW,
  UNDEBATED_RECORD_FILE,
  UNDEBATED_RECORD_VERSION,
  type UndebatedGateOutcome,
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

let runDir: string;

beforeEach(async () => {
  runDir = await fs.mkdtemp(path.join(os.tmpdir(), "f8b-record-"));
});

afterEach(async () => {
  await fs.rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {
    /* temp dir cleanup is best-effort */
  });
});

async function drive(
  gen: AsyncGenerator<StreamChunk, UndebatedGateOutcome, unknown>,
): Promise<{ outcome: UndebatedGateOutcome; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { outcome: value, chunks };
    chunks.push(value);
  }
}

describe("F8b — persisted stance record", () => {
  it("round-trips the council's own stance rows", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    const read = await readUndebatedGateRecord(runDir);
    expect(read?.stanceRows).toEqual([ARGUED, SILENT]);
    expect(read?.resolution).toBeUndefined();
    // Lands where a resume looks for it.
    await expect(fs.stat(path.join(runDir, UNDEBATED_RECORD_FILE))).resolves.toBeTruthy();
  });

  it("returns null — not silence — when nothing was ever recorded", async () => {
    expect(await readUndebatedGateRecord(runDir)).toBeNull();
  });

  it("ignores a corrupt record rather than throwing", async () => {
    await fs.writeFile(path.join(runDir, UNDEBATED_RECORD_FILE), "{not json", "utf8");
    expect(await readUndebatedGateRecord(runDir)).toBeNull();
  });

  it("ignores a record written by an incompatible version", async () => {
    await fs.writeFile(
      path.join(runDir, UNDEBATED_RECORD_FILE),
      JSON.stringify({ version: 99, stanceRows: [SILENT] }),
      "utf8",
    );
    expect(await readUndebatedGateRecord(runDir)).toBeNull();
  });

  it("keeps a human's answer when the stance rows are re-persisted", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    await recordUndebatedResolution(runDir, {
      action: "accept",
      criteria: [{ index: 1, criterion: NUGET }],
      answer: UNDEBATED_OPTION_ACCEPT,
      decidedAt: "2026-09-10T02:00:00.000Z",
    });
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT], (await readUndebatedGateRecord(runDir))?.resolution);
    expect((await readUndebatedGateRecord(runDir))?.resolution?.action).toBe("accept");
  });

  it("refuses to invent stance evidence when asked to record an answer with no record", async () => {
    await recordUndebatedResolution(runDir, {
      action: "accept",
      criteria: [{ index: 0, criterion: NUGET }],
      answer: UNDEBATED_OPTION_ACCEPT,
      decidedAt: "2026-09-10T02:00:00.000Z",
    });
    expect(await readUndebatedGateRecord(runDir)).toBeNull();
  });

  // R4a — the leader's `deferred` flag must survive the real disk round-trip
  // (writeUndebatedStanceRecord / readUndebatedGateRecord), with the record
  // version left untouched, so a future gate can consume it.
  it("round-trips a row's deferred:true flag through the real persistence path", async () => {
    const deferredRow: CouncilStanceRow = { ...SILENT, deferred: true };
    await writeUndebatedStanceRecord(runDir, [ARGUED, deferredRow]);
    const read = await readUndebatedGateRecord(runDir);
    expect(read?.stanceRows).toEqual([ARGUED, deferredRow]);
    expect(read?.stanceRows[1]?.deferred).toBe(true);
    // The version this slice must not bump — a mismatch makes the reader
    // return null, silently forgetting a previously recorded human halt.
    expect(read?.version).toBe(UNDEBATED_RECORD_VERSION);
    expect(UNDEBATED_RECORD_VERSION).toBe(1);
  });

  // No-behaviour-change pin: findUndebatedCriteria must decide identically
  // whether or not a row carries `deferred`. This slice only makes the flag
  // visible on disk — R4b (a later slice) may make the gate consume it, and
  // that consumption must NOT happen here. This assertion must pass both
  // before and after this slice's stance.ts change.
  it("does not change what findUndebatedCriteria decides for a deferred:true row", () => {
    const withoutDeferred = findUndebatedCriteria([ARGUED, SILENT]);
    const withDeferred = findUndebatedCriteria([ARGUED, { ...SILENT, deferred: true }]);
    expect(withDeferred).toEqual(withoutDeferred);
  });
});

describe("F8b — enforceUndebatedCriteriaGate", () => {
  it("persists the rows it was handed, even when the gate does not fire", async () => {
    const respondToQuestion = vi.fn();
    const { outcome } = await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion,
        stanceRows: [ARGUED],
        timeoutMs: 0,
      }),
    );
    expect(outcome).toMatchObject({ proceed: true, source: "all-argued" });
    expect(respondToQuestion).not.toHaveBeenCalled();
    // …and a later resume can now tell "argued" from "no evidence".
    expect((await readUndebatedGateRecord(runDir))?.stanceRows).toEqual([ARGUED]);
  });

  it("fires off the PERSISTED rows when no rows are supplied — the resume shape", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    const respondToQuestion = vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT);

    const { outcome, chunks } = await drive(
      enforceUndebatedCriteriaGate({ runDir, respondToQuestion, timeoutMs: 5_000 }),
    );

    expect(outcome).toMatchObject({ proceed: true, source: "asked", action: "accept" });
    expect(outcome.undebated.map((u) => u.criterion)).toEqual([NUGET]);
    const card = chunks.find((c) => c.type === "council_question");
    expect((card as any)?.councilQuestion?.context).toContain(NUGET);
  });

  it("does nothing when no record exists — missing evidence is not silence", async () => {
    const respondToQuestion = vi.fn();
    const { outcome, chunks } = await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion, timeoutMs: 0 }));
    expect(outcome).toEqual({ proceed: true, source: "no-record", undebated: [] });
    expect(chunks).toEqual([]);
    expect(respondToQuestion).not.toHaveBeenCalled();
  });

  it("does NOT fire on an argued-but-unmet criterion read back off disk", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, stanceRow(NUGET, false, ["-", "~"])]);
    const respondToQuestion = vi.fn();
    const { outcome, chunks } = await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion, timeoutMs: 0 }));
    expect(outcome).toMatchObject({ proceed: true, source: "all-argued" });
    expect(chunks).toEqual([]);
    expect(respondToQuestion).not.toHaveBeenCalled();
  });

  it("records a human answer and honours it on the next call — no second ask", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    const first = vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT);
    await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion: first, timeoutMs: 5_000 }));
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const { outcome, chunks } = await drive(
      enforceUndebatedCriteriaGate({ runDir, respondToQuestion: second, timeoutMs: 5_000 }),
    );

    expect(second).not.toHaveBeenCalled();
    expect(chunks.some((c) => c.type === "council_question")).toBe(false);
    expect(outcome).toMatchObject({ proceed: true, source: "honoured", action: "accept" });
  });

  it("honours a prior 'narrow' without re-asking", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_NARROW),
        timeoutMs: 5_000,
      }),
    );
    const second = vi.fn();
    const { outcome } = await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion: second, timeoutMs: 0 }));
    expect(second).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ proceed: true, source: "honoured", action: "narrow" });
  });

  it("honours a prior 'take it back to the council' by stopping again, silently to the responder", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_COUNCIL),
        timeoutMs: 5_000,
      }),
    );
    const second = vi.fn();
    const { outcome } = await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion: second, timeoutMs: 0 }));
    expect(second).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ proceed: false, source: "honoured", action: "council" });
  });

  it("tells the user WHY the honoured stop cannot be resumed past, and what to run instead", async () => {
    // The dead end measured in session 2bd02af6e46f: the human picks the halt,
    // then `/ideal resume` stops instantly — without even re-showing the card,
    // because the answer is honoured. The line that prints here is the ONLY
    // thing standing between the user and an unexplained loop, so it must name
    // the way out rather than restate the stop.
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_COUNCIL),
        timeoutMs: 5_000,
      }),
    );
    const { chunks } = await drive(
      enforceUndebatedCriteriaGate({ runDir, respondToQuestion: vi.fn().mockResolvedValue(""), timeoutMs: 0 }),
    );
    const text = chunks.map((c) => (c.type === "content" ? (c.content ?? "") : "")).join("");
    expect(text).toContain("/council");
    // A fresh run is the forward path; resuming this one is not.
    expect(text).toContain("/ideal");
    expect(text.toLowerCase()).toMatch(/resume (will|stops|keeps)|stops here again|not continue/);
  });

  it("does NOT persist the unattended default — nobody answered, so nothing is honoured", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    const never = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const { outcome } = await drive(enforceUndebatedCriteriaGate({ runDir, respondToQuestion: never, timeoutMs: 5 }));
    expect(outcome).toMatchObject({ proceed: false, source: "asked", unattended: true });
    expect((await readUndebatedGateRecord(runDir))?.resolution).toBeUndefined();

    // The next (attended) resume gets a real question, not a replayed timeout.
    const answered = vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT);
    const { outcome: next } = await drive(
      enforceUndebatedCriteriaGate({ runDir, respondToQuestion: answered, timeoutMs: 5_000 }),
    );
    expect(answered).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ source: "asked", action: "accept" });
  });

  it("re-asks when a re-run debate produced a DIFFERENT undebated criterion", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT),
        timeoutMs: 5_000,
      }),
    );
    // A later debate leaves a different criterion untouched — a new question.
    const second = vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT);
    const { outcome } = await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: second,
        stanceRows: [stanceRow(VS_WARNING, false, [null, null]), stanceRow(NUGET, true, ["+", "+"])],
        timeoutMs: 5_000,
      }),
    );
    expect(second).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ source: "asked" });
    expect(outcome.undebated.map((u) => u.criterion)).toEqual([VS_WARNING]);
  });

  it("reports every stage to the audit sink so forensics can see a silent skip", async () => {
    await writeUndebatedStanceRecord(runDir, [ARGUED, SILENT]);
    const rows: Array<Record<string, unknown>> = [];
    await drive(
      enforceUndebatedCriteriaGate({
        runDir,
        respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT),
        timeoutMs: 5_000,
        audit: (d) => rows.push(d),
      }),
    );
    expect(rows.map((r) => r.stage)).toEqual(["gate-open", "gate-resolved"]);
    expect(rows[1]).toMatchObject({ action: "accept", unattended: false });
  });
});
