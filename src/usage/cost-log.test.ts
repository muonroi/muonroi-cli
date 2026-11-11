import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCostLog,
  type CostLogEntry,
  collapseDoubleLoggedCompactions,
  costLogTwinView,
  readCostLog,
  setCostLogAttribution,
} from "./cost-log.js";

describe("legacy double-logged compactions", () => {
  // Real pair from cost-log-2026-11-02.jsonl: the compaction path's row
  // (iteration, durationMs, ts = call start) and recordUsage's copy
  // (cachedInputTokens:0, no iteration, ts = write time, 15 s later).
  const authoritative: CostLogEntry = {
    ts: 1793590317151,
    provider: "stepfun",
    model: "step-3.7-flash",
    estimatedUsd: 0.00170785,
    callsite: "orchestrator.compaction",
    phase: "compaction",
    iteration: 1,
    actualInputTokens: 1599,
    actualOutputTokens: 1207,
    durationMs: 15063,
  };
  const recordUsageCopy: CostLogEntry = {
    ts: 1793590332214,
    provider: "stepfun",
    model: "step-3.7-flash",
    estimatedUsd: 0.00170785,
    callsite: "orchestrator.compaction",
    phase: "compaction",
    actualInputTokens: 1599,
    actualOutputTokens: 1207,
    cachedInputTokens: 0,
  };
  const collapse = (rows: CostLogEntry[]) => collapseDoubleLoggedCompactions(rows, costLogTwinView);

  it("drops the recordUsage copy and keeps the compaction path's own row", () => {
    expect(collapse([recordUsageCopy, authoritative])).toEqual([authoritative]);
    expect(collapse([authoritative, recordUsageCopy])).toEqual([authoritative]);
  });

  it("pairs a legacy rejected-summary row with its recordUsage copy", () => {
    const rejected = { ...authoritative, callsite: "orchestrator.compaction.rejected" };
    expect(collapse([rejected, recordUsageCopy])).toEqual([rejected]);
  });

  it("keeps post-fix single rows, even two separate compactions with identical tokens", () => {
    const second = { ...authoritative, ts: authoritative.ts + 60_000, iteration: 2 };
    expect(collapse([authoritative, second])).toEqual([authoritative, second]);
  });

  it("does not pair across different models/tokens or beyond 15 minutes", () => {
    expect(collapse([authoritative, { ...recordUsageCopy, model: "other" }])).toHaveLength(2);
    expect(collapse([authoritative, { ...recordUsageCopy, actualOutputTokens: 1 }])).toHaveLength(2);
    expect(collapse([authoritative, { ...recordUsageCopy, ts: authoritative.ts + 16 * 60_000 }])).toHaveLength(2);
  });

  it("one authoritative row absorbs at most one copy", () => {
    expect(collapse([authoritative, recordUsageCopy, { ...recordUsageCopy, ts: recordUsageCopy.ts + 1 }])).toHaveLength(
      2,
    );
  });

  it("readCostLog returns the collapsed view, so `usage report` counts a compaction once", async () => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-cost-log-collapse-"));
    try {
      await appendCostLog(authoritative, home);
      await appendCostLog(recordUsageCopy, home);
      await appendCostLog(
        { ...authoritative, ts: authoritative.ts + 1, callsite: "orchestrator.task", iteration: undefined },
        home,
      );
      const rows = await readCostLog(undefined, home);
      expect(rows.map((r) => r.callsite)).toEqual(["orchestrator.compaction", "orchestrator.task"]);
      expect(rows[0]?.iteration).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cost-log worker attribution", () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-cost-log-"));
  afterEach(() => setCostLogAttribution(null));

  it("tags rows with the running delegation once attribution is set, and not before", async () => {
    const base = { ts: Date.now(), provider: "p", model: "m", estimatedUsd: 0.01, callsite: "orchestrator.task" };
    await appendCostLog(base, home);
    setCostLogAttribution({ parentSessionId: "parent-1", delegationId: "brisk-amber-fox" });
    await appendCostLog(base, home);
    // An explicit field on the entry wins over the process tag.
    await appendCostLog({ ...base, parentSessionId: "explicit" }, home);

    const rows = await readCostLog(undefined, home);
    expect(rows.map((r) => r.parentSessionId)).toEqual([undefined, "parent-1", "explicit"]);
    expect(rows[1]?.delegationId).toBe("brisk-amber-fox");
    rmSync(home, { recursive: true, force: true });
  });
});
