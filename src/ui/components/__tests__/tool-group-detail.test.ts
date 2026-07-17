import { describe, expect, it } from "vitest";
import type { FileDiff, ToolCall } from "../../../types/index";
import { bashCommandLines, writeOutcomeLine } from "../tool-group.js";

const bashCall = (args: string): ToolCall => ({
  id: "c1",
  type: "function",
  function: { name: "bash", arguments: args },
});

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  filePath: "tests/a.test.js",
  additions: 161,
  removals: 0,
  patch: "",
  isNew: true,
  ...over,
});

describe("bashCommandLines", () => {
  it("splits a multi-line command so the shell transcript stays readable", () => {
    const lines = bashCommandLines(bashCall(JSON.stringify({ command: 'cd "/d/x"\necho hi' })));
    expect(lines).toEqual(['cd "/d/x"', "echo hi"]);
  });

  it("normalizes CRLF", () => {
    expect(bashCommandLines(bashCall(JSON.stringify({ command: "a\r\nb" })))).toEqual(["a", "b"]);
  });

  it("elides a long heredoc instead of flooding the transcript", () => {
    const cmd = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
    const lines = bashCommandLines(bashCall(JSON.stringify({ command: cmd })));
    expect(lines).toHaveLength(9);
    expect(lines?.[8]).toBe("… +4 more lines");
  });

  it("singularizes the elision", () => {
    const cmd = Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join("\n");
    expect(bashCommandLines(bashCall(JSON.stringify({ command: cmd })))?.[8]).toBe("… +1 more line");
  });

  // Arguments arrive as partial JSON while the call is still streaming.
  it("returns null for unparseable or empty args rather than throwing mid-render", () => {
    expect(bashCommandLines(bashCall('{"command": "cd '))).toBeNull();
    expect(bashCommandLines(bashCall(JSON.stringify({ command: "   " })))).toBeNull();
    expect(bashCommandLines(bashCall(JSON.stringify({ notACommand: 1 })))).toBeNull();
  });
});

describe("writeOutcomeLine", () => {
  it("states the write in prose", () => {
    expect(writeOutcomeLine("write_file", diff())).toBe("Wrote 161 lines to tests/a.test.js");
  });

  it("singularizes one line", () => {
    expect(writeOutcomeLine("write_file", diff({ additions: 1 }))).toBe("Wrote 1 line to tests/a.test.js");
  });

  it("reports edits as a +/- delta", () => {
    expect(writeOutcomeLine("edit_file", diff({ additions: 12, removals: 3 }))).toBe("Edited tests/a.test.js (+12 -3)");
  });

  it("is null for tools that do not mutate a file", () => {
    expect(writeOutcomeLine("bash", diff())).toBeNull();
  });
});
