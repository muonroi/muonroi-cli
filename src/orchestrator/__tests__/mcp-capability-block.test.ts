import { describe, expect, it } from "vitest";
import { buildMcpCapabilityBlock } from "../prompts.js";

describe("buildMcpCapabilityBlock", () => {
  it("returns '' when no MCP tools are connected (non-agent / chitchat / no-client-tools turns add nothing)", () => {
    expect(buildMcpCapabilityBlock([])).toBe("");
    expect(buildMcpCapabilityBlock(["read_file", "grep", "bash", "edit_file"])).toBe("");
  });

  it("names the exact callable mcp_<server>__<tool> tools connected this turn (regression: session f6f7881a5fae)", () => {
    const block = buildMcpCapabilityBlock([
      "read_file",
      "bash",
      "mcp_muonroi-docs__setup_guide",
      "mcp_muonroi-docs__docs_search",
    ]);
    // The failure was the agent not knowing it could call setup_guide directly.
    expect(block).toContain("mcp_muonroi-docs__setup_guide");
    expect(block).toContain("mcp_muonroi-docs__docs_search");
    expect(block).toMatch(/CONNECTED MCP TOOLS/);
    // Steers away from the bash-JSON-RPC fallback the agent actually did.
    expect(block).toMatch(/do NOT shell out to bash/i);
  });

  it("groups tools by server (id with a hyphen split on the first '__')", () => {
    const block = buildMcpCapabilityBlock([
      "mcp_muonroi-docs__setup_guide",
      "mcp_context7__query_docs",
      "mcp_muonroi-docs__docs_search",
    ]);
    // muonroi-docs appears once as a group header with both its tools.
    expect(block.match(/muonroi-docs:/g)?.length).toBe(1);
    expect(block).toMatch(/context7:/);
  });

  it("ignores non-mcp tool names and is deterministic (tools sorted within a server)", () => {
    const block = buildMcpCapabilityBlock(["mcp_srv__b_tool", "write_file", "mcp_srv__a_tool"]);
    expect(block).not.toContain("write_file");
    // a_tool sorts before b_tool → stable output regardless of input order.
    expect(block.indexOf("mcp_srv__a_tool")).toBeLessThan(block.indexOf("mcp_srv__b_tool"));
  });
});
