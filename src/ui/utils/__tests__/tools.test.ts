import { describe, expect, it } from "vitest";
import { dominantVerb, verbForTool } from "../tools.js";

describe("verbForTool", () => {
  it("maps the common read tools to 'Reading'", () => {
    expect(verbForTool("read_file")).toBe("Reading");
    expect(verbForTool("read_multiple_files")).toBe("Reading");
    expect(verbForTool("mcp_filesystem__read_text_file")).toBe("Reading");
    expect(verbForTool("mcp__filesystem__read_file")).toBe("Reading");
  });

  it("maps shell to 'Running'", () => {
    expect(verbForTool("bash")).toBe("Running");
  });

  it("maps grep / web search / file search to 'Searching'", () => {
    expect(verbForTool("grep")).toBe("Searching");
    expect(verbForTool("search_web")).toBe("Searching");
    expect(verbForTool("search_x")).toBe("Searching");
    expect(verbForTool("search_files")).toBe("Searching");
    expect(verbForTool("mcp_filesystem__search_files")).toBe("Searching");
  });

  it("maps edit/write to 'Editing'", () => {
    expect(verbForTool("edit_file")).toBe("Editing");
    expect(verbForTool("write_file")).toBe("Editing");
    expect(verbForTool("mcp__filesystem__edit_file")).toBe("Editing");
  });

  it("maps task / delegate to 'Exploring'", () => {
    expect(verbForTool("task")).toBe("Exploring");
    expect(verbForTool("delegate")).toBe("Exploring");
  });

  it("falls back to 'Working' for unknown tools", () => {
    expect(verbForTool("zzz_unknown")).toBe("Working");
  });
});

describe("dominantVerb", () => {
  it("returns 'Working' for empty input", () => {
    expect(dominantVerb([])).toBe("Working");
  });

  it("returns the verb of a single tool", () => {
    expect(dominantVerb(["read_file"])).toBe("Reading");
  });

  it("picks the most-frequent verb across mixed tool names", () => {
    // 3 reads, 1 bash → Reading wins
    expect(dominantVerb(["read_file", "read_file", "read_file", "bash"])).toBe("Reading");
  });

  it("survives unknown tools by falling back to 'Working'", () => {
    expect(dominantVerb(["zzz", "zzz"])).toBe("Working");
  });
});
