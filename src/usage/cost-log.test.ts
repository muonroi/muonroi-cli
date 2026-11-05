import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendCostLog, readCostLog, setCostLogAttribution } from "./cost-log.js";

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
