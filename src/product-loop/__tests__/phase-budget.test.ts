import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordPhaseEnd, recordPhaseStart, renderPhaseSpendSummary } from "../phase-budget.js";

// Phase spend is MEASUREMENT only. The module used to give each phase a share of
// `--max-cost` (PHASE_HINTS × capUsd), flag `warnedOverBudget` past 1.5× that
// share, and tell the user to raise the cap. `/ideal` has no spend cap (user
// decision), so the hints, the flag and the cap are gone; what these tests pin is
// that spend is still recorded truthfully — and still LOUD when unmeasurable.
//
// N4(a) — the gauge reads `usage_events.cost_micros` through `readRunSpendUsd`,
// not the JSONL side-ledger. Mock the gauge, not the ledger.
vi.mock("../run-spend.js", () => ({
  readRunSpendUsd: vi.fn(),
}));

import { readRunSpendUsd } from "../run-spend.js";

const mockGauge = readRunSpendUsd as ReturnType<typeof vi.fn>;

/** A readable spend reading of `usd`, as the gauge would return it. */
function spend(usd: number) {
  return { known: true as const, usd, sessionIds: ["s-root", "s-sub"] };
}

/** A blind gauge — the failure mode that must never render as $0.000. */
function blind(reason: string) {
  return { known: false as const, reason };
}

async function readRecords(flowDir: string, runId: string) {
  const content = await fs.readFile(path.join(flowDir, "runs", runId, "state.md"), "utf8");
  return content;
}

describe("phase spend — measurement only", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `spend-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGauge.mockReset();
  });

  it("records the measured delta and returns no notice when spend is readable", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(1.5));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    const notice = await recordPhaseEnd({ flowDir, runId, marker });
    expect(notice).toBeNull();
    const content = await readRecords(flowDir, runId);
    expect(content).toContain("Phase Spend");
    expect(content).toContain('"spentUsd": 1.5');
    expect(content).not.toMatch(/capUsd|hintUsd|warnedOverBudget/);
  });

  it("never warns, however much a phase spends — there is no hint and no cap", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(10_000));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    expect(await recordPhaseEnd({ flowDir, runId, marker })).toBeNull();
  });

  it("appends multiple phase records over a run, with no cap line in the summary", async () => {
    mockGauge
      .mockReturnValueOnce(spend(0))
      .mockReturnValueOnce(spend(0.5)) // discover
      .mockReturnValueOnce(spend(0.5))
      .mockReturnValueOnce(spend(2.0)); // gather
    const m1 = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, marker: m1 });
    const m2 = await recordPhaseStart({ flowDir, runId, phase: "gather", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, marker: m2 });

    const summary = await renderPhaseSpendSummary(flowDir, runId);
    expect(summary).toContain("discover: $0.500");
    expect(summary).toContain("gather: $1.500");
    // Word-bounded: "discover" contains "cover", which a bare /over/i would match.
    expect(summary).not.toMatch(/\bcap\b|\[OVER\]/i);
  });

  it("renderPhaseSpendSummary returns placeholder when no data", async () => {
    expect(await renderPhaseSpendSummary(flowDir, "never-existed")).toContain("no phase spend data");
  });

  it("clamps negative phase spend to zero (ledger anomaly safety)", async () => {
    mockGauge.mockReturnValueOnce(spend(10)).mockReturnValueOnce(spend(5)); // end < start
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    expect(await recordPhaseEnd({ flowDir, runId, marker })).toBeNull();
    expect(await renderPhaseSpendSummary(flowDir, runId)).toContain("$0.000");
  });

  it("an unreadable gauge records UNKNOWN and says so — never $0.000", async () => {
    mockGauge
      .mockReturnValueOnce(blind("usage_events query failed: disk I/O error"))
      .mockReturnValueOnce(blind("usage_events query failed: disk I/O error"));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    const notice = await recordPhaseEnd({ flowDir, runId, marker });
    expect(notice).toContain("UNKNOWN");
    expect(notice).toContain("disk I/O error");
    const summary = await renderPhaseSpendSummary(flowDir, runId);
    expect(summary).toContain("UNKNOWN");
    expect(summary).not.toContain("$0.000");
  });
});

describe("phase spend — phases and schema", () => {
  it("recordPhaseStart accepts the later phases ('planning', 'verdict')", async () => {
    const flowDir = path.join(os.tmpdir(), `spend-phases-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(0));
    expect((await recordPhaseStart({ flowDir, runId: "r1", phase: "planning", sessionId: "s-root" })).phase).toBe(
      "planning",
    );
    expect((await recordPhaseStart({ flowDir, runId: "r1", phase: "verdict", sessionId: "s-root" })).phase).toBe(
      "verdict",
    );
  });

  it("a record from the old capped 'Phase Budget' section is not read as spend", async () => {
    const flowDir = path.join(os.tmpdir(), `spend-legacy-${Math.random().toString(36).slice(2)}`);
    const runId = "r-legacy";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const legacy = {
      schemaVersion: 3,
      capUsd: 50,
      records: [{ phase: "research", startUsd: 0, endUsd: 5, spentUsd: 5, hintUsd: 10, warnedOverBudget: false }],
    };
    await fs.writeFile(path.join(flowDir, "runs", runId, "state.md"), `## Phase Budget\n\n${JSON.stringify(legacy)}\n`);
    expect(await renderPhaseSpendSummary(flowDir, runId)).toContain("no phase spend data");
  });
});
