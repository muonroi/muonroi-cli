import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBashOutputCache,
  getBashRun,
  listBashRunIds,
  nextBashRunId,
  recordBashRun,
  sliceBashOutput,
  stripAnsi,
} from "./bash-output-cache.js";

beforeEach(() => clearBashOutputCache());

describe("stripAnsi", () => {
  it("removes CSI color sequences", () => {
    expect(stripAnsi("[31mred[0m text")).toBe("red text");
  });
  it("removes vitest's clear-line + cursor-move sequences", () => {
    expect(stripAnsi("[2K[1G PASS test.ts")).toBe(" PASS test.ts");
  });
  it("returns input unchanged when no ANSI codes present", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("recordBashRun / getBashRun", () => {
  it("round-trips a record", () => {
    const id = nextBashRunId();
    recordBashRun({ id, command: "ls", stdout: "a\nb", stderr: "", exitCode: 0, durationMs: 12 });
    const r = getBashRun(id);
    expect(r?.command).toBe("ls");
    expect(r?.stdout).toBe("a\nb");
  });

  it("returns null for unknown id", () => {
    expect(getBashRun("bash-9999")).toBeNull();
  });

  it("LRU evicts oldest entry past 50", () => {
    for (let i = 0; i < 60; i++) {
      recordBashRun({ id: `bash-${i}`, command: "c", stdout: "x", stderr: "", exitCode: 0, durationMs: 1 });
    }
    expect(listBashRunIds().length).toBe(50);
    expect(getBashRun("bash-0")).toBeNull();
    expect(getBashRun("bash-59")).not.toBeNull();
  });

  it("getBashRun touches LRU (most recently used)", () => {
    for (let i = 0; i < 50; i++) {
      recordBashRun({ id: `bash-${i}`, command: "c", stdout: "x", stderr: "", exitCode: 0, durationMs: 1 });
    }
    // Touch bash-0 to make it freshest.
    getBashRun("bash-0");
    recordBashRun({ id: "bash-50", command: "c", stdout: "x", stderr: "", exitCode: 0, durationMs: 1 });
    // bash-1 (the next-oldest after bash-0 was touched) should be evicted.
    expect(getBashRun("bash-0")).not.toBeNull();
    expect(getBashRun("bash-1")).toBeNull();
  });
});

describe("sliceBashOutput", () => {
  const record = {
    id: "bash-x",
    command: "vitest",
    stdout: ["FAIL test/a.spec.ts", "PASS test/b.spec.ts", "ERROR something", "PASS test/c.spec.ts", "Done"].join("\n"),
    stderr: "",
    exitCode: 1,
    durationMs: 100,
    completedAt: new Date().toISOString(),
  };

  it("head returns first N lines", () => {
    expect(sliceBashOutput(record, { mode: "head", lines: 2 }).text).toBe("FAIL test/a.spec.ts\nPASS test/b.spec.ts");
  });

  it("tail returns last N lines", () => {
    expect(sliceBashOutput(record, { mode: "tail", lines: 2 }).text).toBe("PASS test/c.spec.ts\nDone");
  });

  it("grep filters by regex", () => {
    const r = sliceBashOutput(record, { mode: "grep", pattern: "FAIL|ERROR" });
    expect(r.text).toBe("FAIL test/a.spec.ts\nERROR something");
    expect(r.matchedLines).toBe(2);
  });

  it("grep respects caseInsensitive", () => {
    const r = sliceBashOutput(record, { mode: "grep", pattern: "fail", caseInsensitive: true });
    expect(r.matchedLines).toBe(1);
  });

  it("lines extracts a range", () => {
    expect(sliceBashOutput(record, { mode: "lines", range: "2-4" }).text).toBe(
      "PASS test/b.spec.ts\nERROR something\nPASS test/c.spec.ts",
    );
  });

  it("rejects malformed range", () => {
    const r = sliceBashOutput(record, { mode: "lines", range: "garbage" });
    expect(r.ok).toBe(false);
  });

  it("rejects invalid regex without throwing", () => {
    const r = sliceBashOutput(record, { mode: "grep", pattern: "[" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid regex/);
  });

  it("merges stderr into output for slicing", () => {
    const withErr = { ...record, stderr: "stderr line" };
    const r = sliceBashOutput(withErr, { mode: "full" });
    expect(r.text).toContain("[stderr]\nstderr line");
  });
});
