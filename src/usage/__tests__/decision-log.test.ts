import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendDecisionLog, readDecisionLog } from "../decision-log.js";

describe("decision-log scope-gate kind", () => {
  it("accepts and round-trips a scope-gate entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "declog-"));
    await appendDecisionLog(
      { ts: 1, sessionId: "s1", kind: "scope-gate", taken: false, reason: "external", meta: { scopeKind: "external" } },
      home,
    );
    const rows = await readDecisionLog(undefined, home);
    expect(rows.some((r) => r.kind === "scope-gate")).toBe(true);
  });
});
