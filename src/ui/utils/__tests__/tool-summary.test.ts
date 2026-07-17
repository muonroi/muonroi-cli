import { describe, expect, it } from "vitest";
import { activeToolGroupHeader, categoryForTool, doneToolGroupSummary } from "../tool-summary.js";

describe("categoryForTool", () => {
  it("separates write from edit (both are 'Editing' to verbForTool)", () => {
    expect(categoryForTool("write_file")).toBe("write");
    expect(categoryForTool("edit_file")).toBe("edit");
  });

  it("folds MCP filesystem reads in with native reads", () => {
    expect(categoryForTool("read_file")).toBe("read");
    expect(categoryForTool("mcp__filesystem__read_text_file")).toBe("read");
  });

  it("maps bash, search and sub-agents", () => {
    expect(categoryForTool("bash")).toBe("bash");
    expect(categoryForTool("grep")).toBe("search");
    expect(categoryForTool("search_web")).toBe("search");
    expect(categoryForTool("task")).toBe("agent");
    expect(categoryForTool("delegate")).toBe("agent");
  });

  it("falls back to other for unknown tools", () => {
    expect(categoryForTool("totally_new_tool")).toBe("other");
  });
});

describe("activeToolGroupHeader", () => {
  it("counts files, not tool calls", () => {
    expect(activeToolGroupHeader(["read_file", "read_file"])).toBe("Reading 2 files…");
  });

  it("singularizes", () => {
    expect(activeToolGroupHeader(["bash"])).toBe("Running 1 shell command…");
  });

  it("never claims work it is not doing: mixed batch keeps a +N more tail", () => {
    expect(activeToolGroupHeader(["read_file", "read_file", "bash"])).toBe("Reading 2 files +1 more…");
  });

  it("handles an empty batch", () => {
    expect(activeToolGroupHeader([])).toBe("Working…");
  });
});

describe("doneToolGroupSummary", () => {
  // The exact recap the user asked for.
  it("reads like a sentence: 'Read 2 files, ran 1 shell command'", () => {
    expect(doneToolGroupSummary(["read_file", "read_file", "bash"])).toBe("Read 2 files, ran 1 shell command");
  });

  it("capitalizes only the first phrase", () => {
    expect(doneToolGroupSummary(["bash", "read_file"])).toBe("Read 1 file, ran 1 shell command");
  });

  it("keeps a stable phrase order regardless of arrival order", () => {
    const a = doneToolGroupSummary(["bash", "grep", "read_file"]);
    const b = doneToolGroupSummary(["read_file", "bash", "grep"]);
    expect(a).toBe(b);
    expect(a).toBe("Read 1 file, ran 1 shell command, ran 1 search");
  });

  it("falls back to Done for an empty group", () => {
    expect(doneToolGroupSummary([])).toBe("Done");
  });
});
