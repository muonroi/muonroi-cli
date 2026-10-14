import { jsonSchema } from "@ai-sdk/provider-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_FULL_INPUT_SCHEMA } from "../full-schema.js";

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

// The real `tui.start` schema, verbatim from the MCP server's tools/list
// (packages/agent-harness-core/src/mcp-server.ts). `args` is REQUIRED and is an
// array of strings — the exact fact the lazy placeholder used to erase.
const TUI_START_SCHEMA = {
  type: "object",
  properties: {
    args: { maxItems: 20, type: "array", items: { type: "string", maxLength: 200 } },
    cwd: { type: "string", maxLength: 2000 },
    pushMode: { type: "boolean" },
  },
  required: ["args"],
  additionalProperties: false,
};

const fakeMcpClient = {
  tools: async () => ({
    "tui.start": {
      description: "Spawn the muonroi-cli TUI in agent-mode with sanitized argv/env.",
      inputSchema: jsonSchema(TUI_START_SCHEMA),
      execute: async (args: unknown) => ({ ok: true, args }),
    },
    "tui.snapshot": {
      description: "Return the latest LiveFrame.",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (args: unknown) => ({ ok: true, args }),
    },
  }),
  close: async () => {},
};

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => fakeMcpClient),
}));

const SERVER = {
  id: "muonroi-harness",
  label: "muonroi harness (tui.*)",
  enabled: true,
  transport: "stdio" as const,
  command: "bun",
  args: ["run", "src/index.ts", "mcp-driver"],
};

/**
 * Graduation scenario S1 blocker, measured 2026-09-08.
 *
 * A model driving `muonroi-harness` over MCP called `tui.start` twelve times
 * and never produced an accepted payload. Captured from the session DB
 * (`tool_calls.args_json` + the matching assistant tool-call parts): it sent
 * `{}` five times and `{"args":"[]"}` twice, and the server's zod schema
 * rejected each one ("expected array, received undefined" / "received string").
 *
 * Root cause was NOT the model guessing badly with the schema in front of it:
 * `stripMcpInputSchema` replaced every MCP tool's schema with
 * `{type:"object",properties:{},additionalProperties:true}` before it reached
 * the model, and `describe_tool` — the documented escape hatch — served that
 * same empty placeholder. `tui.start` was advertised as a parameterless tool,
 * so `{}` was the only call its published contract implied.
 */
describe("MCP tool parameter discoverability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names required parameters in the description when the schema is not inlined", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([SERVER]);
    const start = bundle.tools["mcp_muonroi-harness__tui_start"] as { description?: string };

    // The one fact the placeholder erased: `args` exists, is required, is string[].
    expect(start.description).toContain("args: string[]");
    expect(start.description).toContain("describe_tool");
    // And the original description survives — the model still knows WHEN to call.
    expect(start.description).toContain("Spawn the muonroi-cli TUI");
  });

  it("leaves a tool with no required parameters exactly as before", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([SERVER]);
    const snapshot = bundle.tools["mcp_muonroi-harness__tui_snapshot"] as {
      description?: string;
      inputSchema?: { jsonSchema?: unknown };
    };
    expect(snapshot.description).not.toContain("Required parameters");
    expect(snapshot.inputSchema?.jsonSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("preserves the real schema for describe_tool while the model still sees the placeholder", async () => {
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([SERVER]);
    const start = bundle.tools["mcp_muonroi-harness__tui_start"] as Record<string, any>;

    // The advertised schema now names the REQUIRED parameter and its type - the
    // one fact without which the tool cannot be called - and nothing else.
    expect(start.inputSchema?.jsonSchema).toEqual({
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
      additionalProperties: true,
    });
    // Optional parameters stay OUT of the advertised payload (still reachable
    // via describe_tool), so the M1 saving survives.
    expect(JSON.stringify(start.inputSchema?.jsonSchema)).not.toContain("cwd");

    // But the real schema is reachable — this is what describe_tool now returns.
    const full = start[MCP_FULL_INPUT_SCHEMA];
    expect(full?.required).toEqual(["args"]);
    expect(full?.properties?.args?.type).toBe("array");
    expect(full?.properties?.args?.items?.type).toBe("string");
  });
});

describe("requiredParamSignature", () => {
  it("renders array parameters with their item type", async () => {
    const { requiredParamSignature } = await import("../runtime.js");
    expect(requiredParamSignature(jsonSchema(TUI_START_SCHEMA))).toBe("args: string[]");
  });

  it("accepts a bare JSON Schema as well as a jsonSchema() wrapper", async () => {
    const { requiredParamSignature } = await import("../runtime.js");
    expect(requiredParamSignature(TUI_START_SCHEMA)).toBe("args: string[]");
  });

  it("returns null when nothing is required", async () => {
    const { requiredParamSignature } = await import("../runtime.js");
    expect(requiredParamSignature({ type: "object", properties: { a: { type: "string" } } })).toBeNull();
    expect(requiredParamSignature(undefined)).toBeNull();
  });

  it("renders several required parameters with their types", async () => {
    const { requiredParamSignature } = await import("../runtime.js");
    const sig = requiredParamSignature({
      type: "object",
      properties: { selector: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["selector", "timeoutMs"],
    });
    expect(sig).toBe("selector: string, timeoutMs: number");
  });
});

describe("buildAdvertisedSchema", () => {
  it("drops descriptions, enums and length bounds from the required stubs", async () => {
    const { buildAdvertisedSchema } = await import("../runtime.js");
    const advertised = buildAdvertisedSchema({
      type: "object",
      properties: {
        name: { type: "string", description: "a very long description", enum: ["a", "b"], maxLength: 200 },
        extra: { type: "string" },
      },
      required: ["name"],
    });
    expect(advertised).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: true,
    });
  });

  it("returns the bare placeholder when nothing is required", async () => {
    const { buildAdvertisedSchema } = await import("../runtime.js");
    expect(buildAdvertisedSchema({ type: "object", properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });
});
