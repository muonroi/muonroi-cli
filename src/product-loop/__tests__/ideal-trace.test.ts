import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idealTrace, isIdealTraceEnabled } from "../ideal-trace.js";

describe("ideal-trace (blocker-5 forensics tracer)", () => {
  let dir: string;
  const prev = process.env.MUONROI_IDEAL_TRACE;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ideal-trace-"));
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_IDEAL_TRACE;
    else process.env.MUONROI_IDEAL_TRACE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled and writes nothing when the env is unset", () => {
    delete process.env.MUONROI_IDEAL_TRACE;
    expect(isIdealTraceEnabled()).toBe(false);
    const file = path.join(dir, "unset.jsonl");
    // With env unset the tracer targets nothing; passing a marker is a no-op.
    idealTrace("council.persist.start", { sessionId: "x" });
    expect(existsSync(file)).toBe(false);
  });

  it('treats "0"/"false" as disabled', () => {
    for (const v of ["0", "false"]) {
      process.env.MUONROI_IDEAL_TRACE = v;
      expect(isIdealTraceEnabled()).toBe(false);
    }
  });

  it("appends one JSONL breadcrumb per call to an explicit path", () => {
    const file = path.join(dir, "trace.jsonl");
    process.env.MUONROI_IDEAL_TRACE = file;
    expect(isIdealTraceEnabled()).toBe(true);

    idealTrace("council.persist.start", { sessionId: "s1", postDebateAction: "generate_plan" });
    idealTrace("council.persist.writeDecisionsLock.before", { sessionId: "s1" });
    idealTrace("council.return", { sessionId: "s1", synthesisLen: 42 });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.marker)).toEqual([
      "council.persist.start",
      "council.persist.writeDecisionsLock.before",
      "council.return",
    ]);
    // Context + timestamp are preserved so a stall can be pinned to a marker.
    expect(rows[0].postDebateAction).toBe("generate_plan");
    expect(rows[2].synthesisLen).toBe(42);
    for (const r of rows) expect(typeof r.ts).toBe("string");
  });
});
