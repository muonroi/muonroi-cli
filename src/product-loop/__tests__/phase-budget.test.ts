import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_HINTS, recordPhaseEnd, recordPhaseStart, renderBudgetSummary } from "../phase-budget.js";

vi.mock("../../usage/product-ledger.js", () => ({
  getProductSpentUsd: vi.fn(),
}));

import { getProductSpentUsd } from "../../usage/product-ledger.js";

const mockGetSpent = getProductSpentUsd as ReturnType<typeof vi.fn>;

describe("phase-budget (P7)", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `budget-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGetSpent.mockReset();
  });

  it("old hints (discover/gather/research/scoping/sprint) sum correctly", () => {
    const oldTotal =
      PHASE_HINTS.discover + PHASE_HINTS.gather + PHASE_HINTS.research + PHASE_HINTS.scoping + PHASE_HINTS.sprint;
    expect(oldTotal).toBeCloseTo(0.85, 2);
  });

  it("returns null warning when phase stays within hint", async () => {
    mockGetSpent.mockResolvedValueOnce(0).mockResolvedValueOnce(1.5);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research" });
    // research hint = 0.35 * 50 = 17.5; spent 1.5 << 17.5*1.5
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).toBeNull();
  });

  it("emits warning when spent exceeds hint by >50%", async () => {
    // discover hint = 0.05 * 50 = 2.5; threshold = 3.75; spent = 5.0 > 3.75
    mockGetSpent.mockResolvedValueOnce(0).mockResolvedValueOnce(5.0);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).not.toBeNull();
    expect(warning).toContain("discover");
    expect(warning).toContain("over");
  });

  it("does not warn when capUsd is zero or negative", async () => {
    mockGetSpent.mockResolvedValueOnce(0).mockResolvedValueOnce(100);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 0, marker });
    expect(warning).toBeNull();
  });

  it("persists per-phase records to state.md", async () => {
    mockGetSpent.mockResolvedValueOnce(0).mockResolvedValueOnce(1.0);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    const stateFile = path.join(flowDir, "runs", runId, "state.md");
    const content = await fs.readFile(stateFile, "utf8");
    expect(content).toContain("Phase Budget");
    expect(content).toContain("discover");
  });

  it("appends multiple phase records over a run", async () => {
    mockGetSpent
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0.5) // discover
      .mockResolvedValueOnce(0.5)
      .mockResolvedValueOnce(2.0); // gather
    const m1 = await recordPhaseStart({ flowDir, runId, phase: "discover" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker: m1 });
    const m2 = await recordPhaseStart({ flowDir, runId, phase: "gather" });
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
    mockGetSpent.mockResolvedValueOnce(0).mockResolvedValueOnce(10.0);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "discover" });
    await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("[OVER]");
  });

  it("clamps negative phase spend to zero (ledger anomaly safety)", async () => {
    mockGetSpent.mockResolvedValueOnce(10).mockResolvedValueOnce(5); // end < start
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research" });
    const warning = await recordPhaseEnd({ flowDir, runId, capUsd: 50, marker });
    expect(warning).toBeNull();
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("$0.000");
  });
});

describe("phase-budget v2 (subsystem E)", () => {
  it("PHASE_HINTS includes new keys planning/review/retro/standup summing to 1.0", () => {
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
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("recordPhaseStart accepts new phase 'planning'", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-v2-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGetSpent.mockResolvedValueOnce(0);
    const marker = await recordPhaseStart({ flowDir, runId: "r1", phase: "planning" as any });
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
