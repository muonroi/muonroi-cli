/**
 * Phase C4 input-keyed read budget tests.
 *
 * Backed by evidence in chat-export-bcf1f0951567 (Agent B report): 3
 * legitimate-looking files (client/vite.config.ts, client/index.html,
 * client/src/main.tsx) were each read 2x across edit turns, missed by C3
 * output-hash dedup because file bytes changed between reads.
 */
import { describe, expect, it } from "vitest";
import { _internals, ReadPathBudget, wrapToolSetWithReadBudget } from "../read-path-budget.js";

describe("ReadPathBudget", () => {
  it("returns null until cap reached, then stub", () => {
    const b = new ReadPathBudget(2);
    expect(b.checkAndIncrement("read_file", "/a/b.ts")).toBeNull();
    expect(b.checkAndIncrement("read_file", "/a/b.ts")).toBeNull();
    const stub = b.checkAndIncrement("read_file", "/a/b.ts");
    expect(stub).toContain("read budget exceeded");
    expect(stub).toContain("/a/b.ts");
  });

  it("normalizes path case + slashes when keying", () => {
    const b = new ReadPathBudget(1);
    expect(b.checkAndIncrement("read_file", "C:\\Foo\\Bar.ts")).toBeNull();
    expect(b.checkAndIncrement("read_file", "c:/foo/bar.ts")).not.toBeNull();
  });

  it("keys per (toolName, path) — different tools share budget independently", () => {
    const b = new ReadPathBudget(1);
    expect(b.checkAndIncrement("read_file", "/a")).toBeNull();
    expect(b.checkAndIncrement("mcp_filesystem__read_text_file", "/a")).toBeNull();
    expect(b.checkAndIncrement("read_file", "/a")).not.toBeNull();
  });

  it("disabled (cap=0) is a no-op", () => {
    const b = new ReadPathBudget(0);
    for (let i = 0; i < 100; i++) {
      expect(b.checkAndIncrement("read_file", "/a")).toBeNull();
    }
  });
});

describe("isReadTool detection", () => {
  it.each([
    ["read_file", true],
    // "Read" (built-in tool in Claude Code) is a read tool — should be budgeted.
    ["Read", true],
    ["mcp_filesystem__read_file", true],
    ["mcp_filesystem__read_text_file", true],
    ["mcp__filesystem__read_file", true],
    ["write_file", false],
    ["list_directory", false],
    ["bash", false],
  ])("'%s' → %s", (name, expected) => {
    expect(_internals.isReadTool(name)).toBe(expected);
  });
});

describe("extractPath", () => {
  it("reads from common arg shapes", () => {
    expect(_internals.extractPath({ path: "/a" })).toBe("/a");
    expect(_internals.extractPath({ file_path: "/b" })).toBe("/b");
    expect(_internals.extractPath({ filePath: "/c" })).toBe("/c");
    expect(_internals.extractPath({})).toBeNull();
    expect(_internals.extractPath(null)).toBeNull();
    expect(_internals.extractPath({ path: "" })).toBeNull();
  });
});

describe("wrapToolSetWithReadBudget", () => {
  function makeReadTool(executeImpl: (input: unknown) => unknown): Record<string, unknown> {
    return {
      description: "read",
      inputSchema: { type: "object" },
      execute: executeImpl,
    };
  }

  it("short-circuits read tool with stub once cap exceeded", async () => {
    const calls: string[] = [];
    const tool = makeReadTool(async (input: unknown) => {
      const p = (input as { path: string }).path;
      calls.push(p);
      return `content of ${p}`;
    });
    const budget = new ReadPathBudget(1);
    const wrapped = wrapToolSetWithReadBudget({ read_file: tool as never }, budget);
    const exec = (wrapped.read_file as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;
    const r1 = await exec({ path: "/x" });
    const r2 = await exec({ path: "/x" });
    expect(r1).toBe("content of /x");
    expect(r2).toMatchObject({});
    expect(String(r2)).toContain("read budget exceeded");
    expect(calls).toEqual(["/x"]); // inner execute only fired once
  });

  it("passes non-read tools through unchanged", () => {
    const tool = makeReadTool(() => "nope");
    const wrapped = wrapToolSetWithReadBudget({ write_file: tool as never }, new ReadPathBudget(1));
    expect(wrapped.write_file).toBe(tool as never);
  });

  it("null budget returns original tool set by reference", () => {
    const tools = { read_file: {} as never };
    expect(wrapToolSetWithReadBudget(tools, null)).toBe(tools);
  });
});
