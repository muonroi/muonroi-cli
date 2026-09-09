import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_HINTS, recordPhaseEnd, recordPhaseStart, renderBudgetSummary } from "../phase-budget.js";

// N4(a) — the budget gauge now reads `usage_events.cost_micros` through
// `readRunSpendUsd`, not the JSONL side-ledger. Mock the gauge, not the ledger.
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

describe("phase-budget (P7)", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `budget-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGauge.mockReset();
  });

  it("old hints (discover/gather/research/scoping/sprint) sum correctly", () => {
    const oldTotal =
      PHASE_HINTS.discover + PHASE_HINTS.gather + PHASE_HINTS.research + PHASE_HINTS.scoping + PHASE_HINTS.sprint;
    expect(oldTotal).toBeCloseTo(0.83, 2);
  });

  it("returns null warning when phase stays within hint", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(1.5));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    // research hint = 0.35 * 50 = 17.5; spent 1.5 << 17.5*1.5
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).toBeNull();
  });

  it("emits warning when spent exceeds hint by >50%", async () => {
    // discover hint = 0.05 * 50 = 2.5; threshold = 3.75; spent = 5.0 > 3.75
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(5.0));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).not.toBeNull();
    expect(warning).toContain("discover");
    expect(warning).toContain("over");
  });

  it("does not warn when capUsd is zero or negative", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(100));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 0, marker });
    expect(warning).toBeNull();
  });

  it("persists per-phase records to state.md", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(1.0));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    const stateFile = path.join(flowDir, "runs", runId, "state.md");
    const content = await fs.readFile(stateFile, "utf8");
    expect(content).toContain("Phase Budget");
    expect(content).toContain("discover");
  });

  it("appends multiple phase records over a run", async () => {
    mockGauge
      .mockReturnValueOnce(spend(0))
      .mockReturnValueOnce(spend(0.5)) // discover
      .mockReturnValueOnce(spend(0.5))
      .mockReturnValueOnce(spend(2.0)); // gather
    const m1 = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker: m1 });
    const m2 = await recordPhaseStart({ flowDir, runId, phase: "gather", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker: m2 });

    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("discover");
    expect(summary).toContain("gather");
    expect(summary).toContain("Cap: $50.00");
  });

  it("renderBudgetSummary returns placeholder when no data", async () => {
    const summary = await renderBudgetSummary(flowDir, "never-existed");
    expect(summary).toContain("no phase budget data");
  });

  it("flags [OVER] in summary when phase exceeded hint", async () => {
    mockGauge.mockReturnValueOnce(spend(0)).mockReturnValueOnce(spend(10.0));
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover", sessionId: "s-root" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("[OVER]");
  });

  it("clamps negative phase spend to zero (ledger anomaly safety)", async () => {
    mockGauge.mockReturnValueOnce(spend(10)).mockReturnValueOnce(spend(5)); // end < start
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "s-root" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).toBeNull();
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("$0.000");
  });
});

describe("phase-budget v2 (subsystem E)", () => {
  it("PHASE_HINTS includes new keys planning/review/retro/standup summing to 0.98 (before verdict)", () => {
    const total =
      PHASE_HINTS.discover +
      PHASE_HINTS.gather +
      PHASE_HINTS.research +
      PHASE_HINTS.scoping +
      PHASE_HINTS.sprint +
      (PHASE_HINTS as any).planning +
      (PHASE_HINTS as any).review +
      (PHASE_HINTS as any).retro +
      (PHASE_HINTS as any).standup;
    expect(total).toBeCloseTo(0.98, 2);
  });

  it("recordPhaseStart accepts new phase 'planning'", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-v2-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGauge.mockReturnValueOnce(spend(0));
    const marker = await recordPhaseStart({ flowDir, runId: "r1", phase: "planning" as any, sessionId: "s-root" });
    expect(marker.phase).toBe("planning");
  });

  it("on resume, persisted records without schemaVersion are skipped", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-v1legacy-${Math.random().toString(36).slice(2)}`);
    const runId = "r-legacy";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const legacy = {
      capUsd: 50,
      records: [{ phase: "research", startUsd: 0, endUsd: 5, spentUsd: 5, hintUsd: 10, warnedOverBudget: false }],
    };
    const statePath = path.join(flowDir, "runs", runId, "state.md");
    await fs.writeFile(statePath, `## Phase Budget\n\n${JSON.stringify(legacy)}\n`);
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("no phase budget data");
  });
});

describe("phase-budget verdict bucket (subsystem F)", () => {
  it("PHASE_HINTS includes 'verdict' bucket, sum still 1.0", () => {
    const total =
      PHASE_HINTS.discover +
      PHASE_HINTS.gather +
      PHASE_HINTS.research +
      PHASE_HINTS.scoping +
      PHASE_HINTS.sprint +
      PHASE_HINTS.planning +
      PHASE_HINTS.review +
      PHASE_HINTS.retro +
      PHASE_HINTS.standup +
      (PHASE_HINTS as any).verdict;
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("sprint hint reduced to 0.28 to make room for verdict 0.02", () => {
    expect(PHASE_HINTS.sprint).toBe(0.28);
    expect((PHASE_HINTS as any).verdict).toBe(0.02);
  });

  it("recordPhaseStart accepts new phase 'verdict'", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-verdict-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGauge.mockReturnValueOnce(spend(0));
    const marker = await recordPhaseStart({ flowDir, runId: "rv", phase: "verdict" as any, sessionId: "s-root" });
    expect(marker.phase).toBe("verdict");
  });
});
