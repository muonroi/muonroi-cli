import { describe, expect, it } from "vitest";
import { extractToolResultFromOutput, isOutputSuccess } from "./tool-results";

describe("extractToolResultFromOutput", () => {
  it("passes through a native ToolResult shape", () => {
    const r = extractToolResultFromOutput({ success: true, output: "hi" });
    expect(r).toMatchObject({ success: true, output: "hi" });
  });

  it("treats error-text as a failure", () => {
    const r = extractToolResultFromOutput({ type: "error-text", value: "boom" });
    expect(r).toMatchObject({ success: false, error: "boom" });
  });

  it("flattens an MCP content envelope into a successful ToolResult (session 63f2d542b772)", () => {
    // MCP tools return { type: "content", value: [{ type: "text", text }] }.
    // Before the fix this returned null, so the persisted output_json had no
    // `success` field and the renderer showed "Error" for a successful call.
    const out = {
      type: "content",
      value: [
        { type: "text", text: "package list" },
        { type: "text", text: "more" },
      ],
    };
    const r = extractToolResultFromOutput(out);
    expect(r).toMatchObject({ success: true, output: "package list\nmore" });
  });

  it("round-trips through JSON so the renderer reads success=true (the actual bug)", () => {
    // transcript.loadStoredToolResults does JSON.parse(output_json) and the
    // renderer reads `.success`. Simulate persist→load and assert it is NOT
    // misread as an error.
    const mcpOutput = { type: "content", value: [{ type: "text", text: "## Muonroi.Core\nNuGet: Muonroi.Core" }] };
    const persisted = JSON.stringify(extractToolResultFromOutput(mcpOutput));
    const loaded = JSON.parse(persisted) as { success?: boolean; output?: string; error?: string };
    const rendered = loaded.success ? loaded.output || "Success" : loaded.error || "Error";
    expect(rendered).toContain("Muonroi.Core");
    expect(rendered).not.toBe("Error");
  });

  it("describes a non-text-only MCP content result instead of dropping to Error", () => {
    const out = { type: "content", value: [{ type: "image", data: "..." }] };
    const r = extractToolResultFromOutput(out);
    expect(r?.success).toBe(true);
    expect(r?.output).toMatch(/non-text MCP part/);
  });

  it("isOutputSuccess still treats content envelopes as success", () => {
    expect(isOutputSuccess({ type: "content", value: [] })).toBe(true);
    expect(isOutputSuccess({ type: "error-text", value: "x" })).toBe(false);
  });
});
