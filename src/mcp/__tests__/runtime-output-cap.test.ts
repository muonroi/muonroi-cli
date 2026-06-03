import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../../tools/registry.js";

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: any, opts: any) {
    Object.assign(this, opts);
  }),
  getDefaultEnvironment: () => ({}),
}));

// MCP client returns a single tool whose execute emits an over-cap payload.
const huge = "X".repeat(MAX_TOOL_OUTPUT_CHARS + 50_000);
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => ({
    tools: async () => ({
      big_query: {
        description: "returns a huge blob",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ type: "content", value: [{ type: "text", text: huge }] }),
      },
    }),
    close: async () => {},
  })),
}));

vi.mock("../validate.js", () => ({
  validateMcpServerConfig: () => ({ ok: true }),
}));

import { buildMcpToolSet } from "../runtime.js";

describe("buildMcpToolSet — MCP output is capped", () => {
  beforeEach(() => vi.clearAllMocks());

  it("truncates an over-cap MCP tool result through the wrapped execute", async () => {
    const bundle = await buildMcpToolSet([
      { id: "demo", label: "Demo", enabled: true, transport: "stdio", command: "x", args: [] },
    ]);
    const tool = bundle.tools.mcp_demo__big_query as {
      execute: (args: unknown, options: unknown) => Promise<{ value: Array<{ text: string }> }>;
    };
    expect(tool).toBeDefined();
    const out = await tool.execute({}, {});
    const text = out.value[0]!.text;
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("truncated");
    await bundle.close();
  });
});
