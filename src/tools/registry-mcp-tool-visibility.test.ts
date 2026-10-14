import os from "node:os";
import { jsonSchema } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_FULL_INPUT_SCHEMA } from "../mcp/full-schema.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools, setLiveToolSet } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown) => Promise<unknown> | unknown;
}

const REAL_SCHEMA = {
  type: "object",
  properties: { args: { type: "array", items: { type: "string" } } },
  required: ["args"],
  additionalProperties: false,
};

/** An MCP tool as the engine merges it in: placeholder schema, real one alongside. */
function mcpTool() {
  return {
    description: "[MCP muonroi harness (tui.*)] Spawn the muonroi-cli TUI in agent-mode.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: true }),
    [MCP_FULL_INPUT_SCHEMA]: REAL_SCHEMA,
    execute: async () => ({}),
  };
}

async function run(tool: unknown, input: unknown): Promise<string> {
  const out = await (tool as ToolWithExecute).execute!(input);
  return String(out);
}

/**
 * `list_tools` and `describe_tool` close over the object `createBuiltinTools`
 * builds, which never contains MCP tools: the engine merges them with
 * `{...rawToolSet, ...mcpTools}`, producing a NEW object. Measured in the
 * 2026-09-08 graduation session, `list_tools({category:"mcp"})` answered
 * `{"mcp_count":0,"mcp":[]}` while 21 `mcp_muonroi-harness__*` tools were live.
 */
describe("list_tools / describe_tool see the MCP tools the model was shown", () => {
  afterEach(() => {
    setLiveToolSet(null);
  });

  it("cannot see an MCP tool until the engine publishes the assembled set", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const out = await run(tools.describe_tool, { name: "mcp_muonroi-harness__tui_start" });
    expect(out).toContain("Tool not found");
  });

  it("describe_tool returns the REAL MCP schema once the set is published", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    setLiveToolSet({ ...tools, "mcp_muonroi-harness__tui_start": mcpTool() } as never);

    const out = await run(tools.describe_tool, { name: "mcp_muonroi-harness__tui_start" });
    const parsed = JSON.parse(out) as { inputSchema?: { required?: string[]; properties?: Record<string, unknown> } };
    // NOT the `{properties:{}}` placeholder the model is shown.
    expect(parsed.inputSchema?.required).toEqual(["args"]);
    expect(parsed.inputSchema?.properties).toHaveProperty("args");
  });

  it("list_tools counts the published MCP tools", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");

    const before = JSON.parse(await run(tools.list_tools, { category: "mcp" })) as { mcp_count: number };
    expect(before.mcp_count).toBe(0);

    setLiveToolSet({ ...tools, "mcp_muonroi-harness__tui_start": mcpTool() } as never);
    const after = JSON.parse(await run(tools.list_tools, { category: "mcp" })) as {
      mcp_count: number;
      mcp: string[];
    };
    expect(after.mcp_count).toBe(1);
    expect(after.mcp[0]).toContain("mcp_muonroi-harness__tui_start");
  });
});
