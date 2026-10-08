import { jsonSchema } from "@ai-sdk/provider-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock keychain — not relevant here.
vi.mock("../mcp-keychain.js", () => ({
  getMcpKey: vi.fn(async () => null),
  setMcpKey: vi.fn(async () => true),
  deleteMcpKey: vi.fn(async () => true),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: any, opts: any) {
    Object.assign(this, opts);
  }),
  getDefaultEnvironment: () => ({}),
}));

vi.mock("../validate.js", () => ({
  validateMcpServerConfig: () => ({ ok: true }),
}));

// Build a synthetic registry of 10 MCP tools, each with a realistic ~1.2 KB
// JSON schema. The control test ("eager") goes through the AI SDK exactly as
// our code path does; the lazy test asserts the schema is stripped.
function makeFatSchema(toolIndex: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  // 12 string properties with description/enum/pattern — typical for a real
  // MCP tool advertising rich args. Pads each tool's schema to ~1 KB+.
  for (let i = 0; i < 12; i++) {
    properties[`field_${i}`] = {
      type: "string",
      description: `Tool ${toolIndex} field ${i} — accepts a string of moderate length and represents a parameter the MCP server cares about. Longer descriptions are common in real MCP tools.`,
      enum: ["one", "two", "three", "four", "five", "six"],
      pattern: "^[a-zA-Z0-9_-]+$",
    };
  }
  return {
    type: "object",
    properties,
    required: ["field_0", "field_1", "field_2"],
    additionalProperties: false,
  };
}

function makeTenFatTools() {
  const tools: Record<
    string,
    { description: string; inputSchema: unknown; execute: (args: unknown) => Promise<unknown> }
  > = {};
  for (let i = 0; i < 10; i++) {
    const name = `tool_${i}`;
    tools[name] = {
      description: `Synthetic MCP tool number ${i}`,
      inputSchema: jsonSchema(makeFatSchema(i)),
      execute: async (args: unknown) => ({ ok: true, args }),
    };
  }
  return tools;
}

const fakeMcpClient = {
  tools: async () => makeTenFatTools(),
  close: async () => {},
};

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => fakeMcpClient),
}));

// Helper: compute the wire-payload-sized byte count of the tool's inputSchema
// as it would be serialized to the provider. The AI SDK reads
// `tool.inputSchema.jsonSchema` (via `asSchema(...)`) and that is what gets
// JSON-serialized into the provider tool definition.
function schemaPayloadBytes(tool: unknown): number {
  const schema = (tool as { inputSchema?: { jsonSchema?: unknown } })?.inputSchema?.jsonSchema;
  if (!schema) return 0;
  return Buffer.byteLength(JSON.stringify(schema), "utf8");
}

function totalSchemaBytes(tools: Record<string, unknown>): number {
  let total = 0;
  for (const t of Object.values(tools)) total += schemaPayloadBytes(t);
  return total;
}

describe("M1 — MCP lazy schema loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips per-tool inputSchema to a minimal placeholder", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([
      {
        id: "fake",
        label: "Fake MCP",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "fake"],
      },
    ]);

    expect(bundle.errors).toHaveLength(0);
    expect(Object.keys(bundle.tools)).toHaveLength(10);

    for (const tool of Object.values(bundle.tools)) {
      const schema = (tool as { inputSchema?: { jsonSchema?: Record<string, unknown> } }).inputSchema?.jsonSchema;
      expect(schema).toBeDefined();
      // OpenAI Responses API requires `properties` to be present (even empty);
      // Anthropic / DeepSeek tolerate omitting it.
      expect(schema?.type).toBe("object");
      expect(schema?.additionalProperties).toBe(true);

      // REQUIRED properties are advertised as type-only stubs. This assertion
      // replaces the original `properties === {}` / `no required` pair, which
      // encoded a defect rather than a budget: M1 assumed "the real schema only
      // matters at execution time, which the MCP server already enforces", but a
      // required argument the model cannot see makes the tool UNCALLABLE. Measured
      // 2026-09-09 with step-3.7-flash against `tui.start` (required `args:
      // string[]`): 12 calls under the empty placeholder, 3 more with the type
      // named in the description, 0 accepted - every one malformed on `args`.
      expect(schema?.required).toEqual(["field_0", "field_1", "field_2"]);
      expect(schema?.properties).toEqual({
        field_0: { type: "string" },
        field_1: { type: "string" },
        field_2: { type: "string" },
      });

      // The budget itself, asserted directly instead of via the old byte band:
      // NONE of the verbose keywords that made the eager schema 1-5 KB survive,
      // and the 9 non-required properties are still absent.
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toMatch(/description|enum|pattern|maxLength/);
      expect(serialized).not.toContain("field_3");

      // Description is preserved (the model needs it to decide WHEN to call).
      expect((tool as { description?: string }).description).toMatch(/Synthetic MCP tool number/);
    }
  });

  it("lazy payload is <1 KB while eager payload is >10 KB for 10 tools", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");

    // Eager baseline = the raw fixture tools, unwrapped (what we'd send if we
    // didn't strip).
    const eagerTools = makeTenFatTools();
    const eagerBytes = totalSchemaBytes(eagerTools as unknown as Record<string, unknown>);

    const bundle = await buildMcpToolSet([
      {
        id: "fake",
        label: "Fake MCP",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "fake"],
      },
    ]);
    const lazyBytes = totalSchemaBytes(bundle.tools as unknown as Record<string, unknown>);

    // Acceptance bands from the M1 brief, restated for required-property stubs.
    // The original band (<1 KB, 20x) was measured against a payload that carried
    // NO parameter information at all; these fixtures are deliberately fat (3
    // required fields per tool), so the stubs cost ~190 B/tool. Real MCP tools
    // mostly have 0-2 required scalars and stay near the old number.
    expect(eagerBytes).toBeGreaterThan(10_000);
    expect(lazyBytes).toBeLessThan(2_500);

    // And a sanity ratio: lazy should be at least ~10x smaller.
    expect(lazyBytes * 10).toBeLessThan(eagerBytes);
  });

  it("tool-call still routes to the MCP server execute() — args pass through unchanged", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([
      {
        id: "fake",
        label: "Fake MCP",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "fake"],
      },
    ]);

    const first = Object.values(bundle.tools)[0] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> };
    expect(typeof first.execute).toBe("function");

    // Send args that would FAIL the eager full schema (extra fields,
    // missing-required-fields). Under lazy loading these still pass through to
    // the MCP server's execute, which is where the real validation happens.
    const result = await first.execute!({ surprise_field: 42 }, {});
    expect(result).toEqual({ ok: true, args: { surprise_field: 42 } });
  });
});
