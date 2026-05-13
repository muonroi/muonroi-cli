/**
 * Patch tool schema serialization for Zod v4 + AI SDK v6 compatibility.
 *
 * AI SDK v6 uses `asSchema()` which handles Zod v4 Standard Schema correctly,
 * but tools created via `tool()` helper have `parameters` (not `inputSchema`),
 * causing `asSchema(undefined)` → empty schema `{ properties: {}, additionalProperties: false }`.
 *
 * Two-phase fix:
 * 1. `captureToolSchemas()` — called when ToolSet is built, stores the
 *    original JSON Schema keyed by tool name. Handles both `parameters`
 *    (tool() helper) and `inputSchema` (dynamicTool/MCP) properties.
 * 2. `patchZodToJsonSchema()` — wraps global fetch to intercept
 *    /chat/completions requests and replace broken schemas with the
 *    captured originals.
 */

const schemaRegistry = new Map<string, Record<string, unknown>>();

/**
 * Capture original tool schemas before AI SDK processes them.
 * Call this after building the ToolSet, before any streamText() call.
 *
 * Handles both tool() tools (which have `parameters`) and dynamicTool/MCP
 * tools (which have `inputSchema`).
 */
export function captureToolSchemas(tools: Record<string, unknown>): void {
  for (const [name, def] of Object.entries(tools)) {
    if (!def || typeof def !== "object") continue;
    const t = def as Record<string, unknown>;

    // Try `inputSchema` first (dynamicTool / MCP tools), then `parameters` (tool() helper)
    const schemaSource = t.inputSchema ?? t.parameters;
    if (!schemaSource) continue;

    const src = schemaSource as Record<string, unknown>;

    // jsonSchema() helper stores original at .jsonSchema
    const raw = src.jsonSchema;
    if (raw && typeof raw === "object" && (raw as any).type) {
      schemaRegistry.set(name, { ...(raw as Record<string, unknown>) });
      continue;
    }

    // Zod v4 schema — convert via z.toJSONSchema if available
    try {
      const z = require("zod");
      if (typeof z.toJSONSchema === "function" && (src as any)._def) {
        const converted = z.toJSONSchema(src);
        delete converted.$schema;
        schemaRegistry.set(name, converted);
      }
    } catch {}

    // Standard Schema — extract via ~standard
    if ("~standard" in src) {
      try {
        const std = (src as any)["~standard"];
        if (std?.jsonSchema?.input) {
          const jsonSch = std.jsonSchema.input({ target: "draft-07" });
          if (jsonSch && typeof jsonSch === "object" && jsonSch.type) {
            const clean = { ...jsonSch };
            delete clean.$schema;
            schemaRegistry.set(name, clean);
          }
        }
      } catch {}
    }
  }
}

export function patchZodToJsonSchema(): void {
  const originalFetch = globalThis.fetch;
  if ((originalFetch as any).__zodPatched) return;

  globalThis.fetch = async function patchedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (init?.method === "POST" && init.body && typeof init.body === "string") {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/completions")) {
        try {
          const body = JSON.parse(init.body);
          if (fixBrokenToolSchemas(body)) {
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch {}
      }
    }
    return originalFetch(input, init!);
  } as typeof fetch;
  (globalThis.fetch as any).__zodPatched = true;
}

function fixBrokenToolSchemas(body: Record<string, unknown>): boolean {
  const tools = body.tools as
    | Array<{
        type: string;
        function: { name: string; parameters: Record<string, unknown> };
      }>
    | undefined;
  if (!Array.isArray(tools)) return false;
  let modified = false;
  for (const tool of tools) {
    const params = tool?.function?.parameters;
    if (!params) continue;

    // Remove $schema field — some providers (DeepSeek) don't like it
    if (params.$schema) {
      delete params.$schema;
      modified = true;
    }

    // Check if schema is broken (empty properties or missing type)
    const isBroken =
      !params.type ||
      (params.properties && typeof params.properties === "object" && Object.keys(params.properties).length === 0);
    if (!isBroken) continue;
    const cached = schemaRegistry.get(tool.function.name);
    if (cached) {
      tool.function.parameters = { ...cached };
      modified = true;
    } else {
      if (!params.type) params.type = "object";
      modified = true;
    }
  }
  return modified;
}
