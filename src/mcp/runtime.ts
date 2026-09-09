import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "@ai-sdk/provider-utils";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings.js";
import { capMcpToolResult } from "./cap-tool-result.js";
import { MCP_FULL_INPUT_SCHEMA } from "./full-schema.js";
import {
  MCP_KEY_REQUIREMENTS,
  type MissingKeyServer,
  noticeNeedsKeyOnce,
  partitionEnabledServers,
} from "./key-requirements.js";
import { getMcpKey } from "./mcp-keychain.js";
import { createOAuthProviderWithCallback } from "./oauth-provider.js";
import { validateMcpServerConfig } from "./validate.js";

async function hydrateServerEnv(server: McpServerConfig): Promise<McpServerConfig> {
  const hydration = MCP_KEY_REQUIREMENTS[server.id];
  if (!hydration) return server;
  const existing = server.env?.[hydration.envVar];
  if (existing && existing.length > 0) return server;
  const key = await getMcpKey(hydration.keyId);
  if (!key) return server;
  return { ...server, env: { ...(server.env ?? {}), [hydration.envVar]: key } };
}

function mcpToolPrefix(server: McpServerConfig): string {
  return `mcp_${server.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// Phase M1 — lazy schema loading.
//
// The AI SDK's MCP client returns tools whose `inputSchema` carries the full
// JSON Schema advertised by the MCP server. That schema is serialized into the
// provider tool definition for EVERY `streamText` call, regardless of which
// MCP tools the model actually invokes. With 5+ servers × 20+ tools × 1-5 KB
// per schema, this trivially adds 100-500 KB of overhead to every model call.
//
// The fix: ship a minimal placeholder schema (`{ type: "object",
// additionalProperties: true }`) to the model, and let the real MCP server
// validate args downstream when the tool is actually called. The model
// continues to know the tool's name + description so it can decide when to
// call; the real schema only matters at execution time, which the MCP server
// already enforces.
//
// Args validation: the AI SDK's `dynamicTool` factory only runs `validate()`
// when present on the schema, and the MCP client never sets it (see
// `jsonSchema(...)` in @ai-sdk/provider-utils — no `validate` arg). So this
// change preserves the existing validation surface exactly (none on our side;
// all enforced by the MCP server).
// OpenAI Responses API rejects object schemas without a `properties` field
// (HTTP 400 invalid_function_parameters). Anthropic/DeepSeek don't enforce
// this. Always emit `properties: {}` alongside `additionalProperties: true`
// so the schema is portable across providers.
const LAZY_MCP_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
  additionalProperties: true,
};

/** Unwrap `jsonSchema(x)` → `x`; pass a bare JSON Schema object through. */
function unwrapJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const inner = (schema as { jsonSchema?: unknown }).jsonSchema;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return schema as Record<string, unknown>;
}

/**
 * Minimal JSON Schema type stub for one property: `type` only (plus `items.type`
 * for arrays). Descriptions, enums, patterns and length bounds are dropped -
 * they are what made the eager schema 1-5 KB per tool, and the server revalidates
 * all of them anyway.
 */
function minimalPropSchema(prop: unknown): Record<string, unknown> {
  const p = (prop ?? {}) as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : undefined;
  if (type === undefined) return {};
  if (type !== "array") return { type };
  const items = p.items as Record<string, unknown> | undefined;
  const itemType = typeof items?.type === "string" ? items.type : undefined;
  return itemType ? { type, items: { type: itemType } } : { type };
}

/**
 * The schema actually advertised to the model: the lazy placeholder PLUS a
 * type-only stub for each REQUIRED property.
 *
 * M1's premise was that "the real schema only matters at execution time, which
 * the MCP server already enforces". That is empirically false for required
 * parameters, and the cost is total rather than marginal - a tool whose required
 * argument the model cannot see is not called badly, it is uncallable.
 *
 * Measured against `tui.start` (required `args: string[]`) with `step-3.7-flash`:
 *  - placeholder only .................. `{}` x5, `{"args":"[]"}` x2, 12 calls, 0 accepted
 *  - placeholder + prose in description . `{"args":"[]"}` x3, 0 accepted
 *    (naming the parameter in prose gets the field emitted; only the schema
 *     gets its TYPE right)
 *  - required-property stubs (this) ..... see mcp-schema-discoverability.spec
 *
 * Optional parameters stay out, and `additionalProperties: true` keeps them
 * callable; `describe_tool` serves the full schema on demand
 * (MCP_FULL_INPUT_SCHEMA). So the M1 saving is preserved for everything except
 * the handful of bytes without which the call cannot be made at all.
 */
export function buildAdvertisedSchema(schema: unknown): Record<string, unknown> {
  const js = unwrapJsonSchema(schema);
  const required = Array.isArray(js?.required) ? js.required.filter((k): k is string => typeof k === "string") : [];
  if (required.length === 0) return LAZY_MCP_INPUT_SCHEMA;
  const props = (js?.properties ?? {}) as Record<string, unknown>;
  const properties: Record<string, unknown> = {};
  for (const key of required) properties[key] = minimalPropSchema(props[key]);
  return { type: "object", properties, required, additionalProperties: true };
}

/**
 * One-line signature of a tool's REQUIRED parameters, e.g. `args: string[]`.
 *
 * Mirrors `buildAdvertisedSchema` in prose for `describe_tool`-less surfaces and
 * for models that read descriptions more reliably than schemas. Measured on its
 * own it is NOT sufficient (see buildAdvertisedSchema) - it is belt to that
 * braces, not a substitute.
 */
export function requiredParamSignature(schema: unknown): string | null {
  const js = unwrapJsonSchema(schema);
  const required = js?.required;
  if (!Array.isArray(required) || required.length === 0) return null;
  const props = (js?.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const parts: string[] = [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    const p = props[key];
    const type = typeof p?.type === "string" ? (p.type as string) : "any";
    if (type === "array") {
      const items = p?.items as { type?: unknown } | undefined;
      const itemType = typeof items?.type === "string" ? items.type : "any";
      parts.push(`${key}: ${itemType}[]`);
    } else {
      parts.push(`${key}: ${type}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function stripMcpInputSchema<T extends { inputSchema?: unknown; description?: string }>(tool: T): T {
  // Replace the full schema with a permissive placeholder. We keep `description`
  // and `execute` (and any other fields) intact. Many MCP tools also have an
  // `outputSchema`; we leave that alone since the AI SDK uses it only to parse
  // structured tool results — it doesn't ship to the model.
  //
  // Two corrections to the original strip:
  //  - the advertised schema keeps a type-only stub for each REQUIRED property
  //    (buildAdvertisedSchema), because a required argument the model cannot see
  //    makes the tool uncallable, not merely awkward;
  //  - the real schema is NOT discarded - it rides along on MCP_FULL_INPUT_SCHEMA
  //    so `describe_tool` can still answer "what are this tool's parameters?".
  //    Before this, describe_tool returned the empty placeholder too, leaving no
  //    in-CLI path at all by which a model could learn a required argument existed.
  return {
    ...tool,
    inputSchema: jsonSchema(buildAdvertisedSchema(tool.inputSchema)),
    [MCP_FULL_INPUT_SCHEMA]: unwrapJsonSchema(tool.inputSchema),
  };
}

function getMcpStdioRunner(): { command: string; prefixArgs: string[] } {
  // Prefer Bun's runner because:
  // - The CLI is launched via `bun run`
  // - npx .cmd shims have been observed to cause immediate "Connection closed"
  //   (MCPClientError) for StdioClientTransport on Windows + Bun (see probe results).
  // - bun x resolves + spawns package bins with clean stdio pipes.
  return { command: "bun", prefixArgs: ["x", "-y"] };
}

/**
 * Upgrade legacy "npx" (or npm exec) invocations recorded in user settings
 * to the bun-based runner. This heals persisted configs from before the fix
 * without requiring the user to re-run setup.
 */
function normalizeStdioCommand(command: string, args: string[] | undefined): { command: string; args: string[] } {
  const a = args ?? [];
  if (command === "npx" || (command === "npm" && a[0] === "exec")) {
    const r = getMcpStdioRunner();
    const pkgArgs = a.filter((x) => x !== "-y");
    return { command: r.command, args: [...r.prefixArgs, ...pkgArgs] };
  }
  return { command, args: a };
}

function toTransport(server: McpServerConfig, authProvider?: OAuthClientProvider) {
  if (server.transport === "stdio") {
    const { command, args } = normalizeStdioCommand(server.command ?? "", server.args);
    return new StdioClientTransport({
      command,
      args,
      env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
      cwd: server.cwd,
      stderr: "pipe",
    });
  }

  return {
    type: server.transport,
    url: server.url ?? "",
    headers: server.headers,
    ...(authProvider ? { authProvider: authProvider as any } : {}),
  } as const;
}

export interface McpToolBundle {
  tools: ToolSet;
  errors: string[];
  /**
   * Enabled servers skipped because they need an API key they do not have. NOT
   * counted as errors (they are unconfigured, not broken) — surfaced once for
   * the inline fix card + one-time notice. Empty when everything is configured.
   */
  needsKey: MissingKeyServer[];
  close(): Promise<void>;
}

export interface McpBuildOptions {
  onOAuthRequired?: (serverId: string, url: URL) => void;
  /**
   * Server ids the CURRENT turn critically needs (e.g. muonroi-docs on an
   * ecosystem question). acquireMcpTools waits for these specifically beyond the
   * normal build deadline — up to `criticalDeadlineMs` — so a cold first-connect
   * is included THIS turn instead of "ready next turn" (session 584ba476c07a:
   * first ecosystem question missed muonroi-docs while it was still warming).
   * Other servers are unaffected — only the named ones get the extended wait.
   */
  criticalServerIds?: string[];
  /** Extended ceiling (ms) for criticalServerIds. Default 8000. */
  criticalDeadlineMs?: number;
}

/**
 * Total wall-clock budget for building the MCP tool set. Servers connect in
 * PARALLEL and whatever has connected by the deadline is returned; slower
 * servers are reported in `.errors` (and closed if they connect late) instead
 * of sinking the whole bundle. Default 2500ms; override with
 * MUONROI_MCP_BUILD_DEADLINE_MS (500–20000).
 *
 * Phase 1c — the OLD design built servers SEQUENTIALLY under an outer race
 * (message-processor) that discarded EVERYTHING on timeout, so one slow `npx`
 * stdio spawn starved a fast HTTP server and left the agent blind to MCP tools
 * that were actually reachable (live: muonroi-docs ~300ms dropped behind slow
 * npx servers, session f6f7881a5fae). Parallel + partial-at-deadline fixes it.
 */
export function getMcpBuildDeadlineMs(): number {
  const v = Number(process.env.MUONROI_MCP_BUILD_DEADLINE_MS);
  if (Number.isFinite(v) && v >= 500 && v <= 20_000) return v;
  return 2500;
}

export interface ConnectedServer {
  tools: ToolSet;
  client: MCPClient;
  /** OAuth provider teardown, when one was created for this server. */
  cleanup?: () => void;
}

/**
 * Connect ONE server and build its prefixed, output-capped tool set. Throws on
 * any failure; the caller owns lifecycle of the returned client/cleanup.
 * Exported so the cross-turn client pool (client-pool.ts) can reuse it as its
 * connect primitive.
 */
export async function connectOneServer(rawServer: McpServerConfig, opts?: McpBuildOptions): Promise<ConnectedServer> {
  // Hydrate env vars from the OS keychain before spawning — e.g. inject
  // TAVILY_API_KEY for the tavily MCP if stored via the research-onboarding wizard.
  const server = await hydrateServerEnv(rawServer);

  // Fast-fail for servers that require keys but have none. Prevents "Connection closed"
  // with zero actionable info. The server binary may start and list tools, but first
  // use would fail — better to give clear guidance at warmup time.
  if (server.id === "tavily") {
    const key = server.env?.TAVILY_API_KEY;
    if (!key || key.length < 16) {
      throw new Error(
        "Tavily is enabled but TAVILY_API_KEY is missing. Run `muonroi-cli mcp setup-research` or `muonroi-cli mcp key tavily`, or disable the server in /mcp config.",
      );
    }
  }

  let authProvider: OAuthClientProvider | undefined;
  let cleanup: (() => void) | undefined;
  if (server.transport !== "stdio" && opts?.onOAuthRequired) {
    const oauthResult = await createOAuthProviderWithCallback({
      serverId: server.id,
      onAuthorizationUrl: (url: URL) => opts.onOAuthRequired!(server.id, url),
    });
    authProvider = oauthResult.provider;
    cleanup = oauthResult.close;
  }

  const client = await createMCPClient({
    transport: toTransport(server, authProvider),
    name: `muonroi-cli-${server.id}`,
    version: "1.0.0",
  });

  const mcpTools = await client.tools();
  const prefix = mcpToolPrefix(server);
  const tools: ToolSet = {};
  for (const [name, tool] of Object.entries(mcpTools)) {
    // OpenAI/DeepSeek function-name regex: ^[a-zA-Z0-9_-]+$. MCP spec does not
    // restrict server-side tool names, so we sanitize here. The tool's execute()
    // closure still calls the MCP server with the original name.
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const prefixedName = `${prefix}__${safeName}`;
    const stripped = stripMcpInputSchema(tool as { inputSchema?: unknown; description?: string });
    // The advertised schema is the empty placeholder, so a tool with a REQUIRED
    // parameter reads to the model as parameterless and is uncallable. Name the
    // required parameters (types only — not the full schema) so the first call
    // can be well-formed, and point at describe_tool for the rest.
    const signature = requiredParamSignature((tool as { inputSchema?: unknown }).inputSchema);
    const paramNote = signature
      ? ` Required parameters (schema not inlined — call describe_tool({name:"${prefixedName}"}) for the full schema): ${signature}.`
      : "";
    // Cap MCP tool output the same way built-in tools are capped so the raw
    // server payload doesn't stream into context uncapped. See cap-tool-result.ts.
    const baseExecute = (stripped as { execute?: (args: unknown, options: unknown) => Promise<unknown> }).execute;
    tools[prefixedName] = {
      ...(stripped as object),
      description: `[MCP ${server.label}] ${tool.description ?? name}${paramNote}`,
      ...(typeof baseExecute === "function"
        ? { execute: async (args: unknown, options: unknown) => capMcpToolResult(await baseExecute(args, options)) }
        : {}),
    } as ToolSet[string];
  }
  return { tools, client, cleanup };
}

export async function buildMcpToolSet(servers: McpServerConfig[], opts?: McpBuildOptions): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];
  const cleanups: (() => void)[] = [];

  // One slot per enabled server, filled synchronously as each connect settles —
  // so at the deadline we can tell ready (merge) from still-pending (report+late-close).
  interface Slot {
    label: string;
    done: boolean;
    result?: ConnectedServer;
    error?: string;
  }
  // Partition OUT enabled-but-keyless servers before connecting: they are
  // unconfigured (native fallbacks cover them), not per-turn failures. This is
  // the fix for the "⚠️ tavily unavailable: TAVILY_API_KEY is missing" nag.
  const { connectable: enabled, needsKey } = await partitionEnabledServers(servers);
  noticeNeedsKeyOnce(needsKey);
  const slots: Slot[] = enabled.map((s) => ({ label: s.label, done: false }));

  const attempts = enabled.map((rawServer, i) => {
    const validation = validateMcpServerConfig(rawServer);
    if (!validation.ok) {
      slots[i] = { label: rawServer.label, done: true, error: validation.error };
      return Promise.resolve();
    }
    return connectOneServer(rawServer, opts).then(
      (result) => {
        slots[i] = { label: rawServer.label, done: true, result };
      },
      (error: unknown) => {
        slots[i] = {
          label: rawServer.label,
          done: true,
          error: error instanceof Error ? error.message : String(error),
        };
      },
    );
  });

  const deadlineMs = getMcpBuildDeadlineMs();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, deadlineMs);
    deadlineTimer.unref?.();
  });
  await Promise.race([Promise.allSettled(attempts), deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (slot.done) {
      if (slot.error) {
        errors.push(`${slot.label}: ${slot.error}`);
      } else if (slot.result) {
        Object.assign(tools, slot.result.tools);
        clients.push(slot.result.client);
        if (slot.result.cleanup) cleanups.push(slot.result.cleanup);
      }
    } else {
      // Still connecting at the deadline: report it and close it if/when it
      // eventually connects so the child process / socket doesn't leak.
      errors.push(`${slot.label}: not ready within ${deadlineMs}ms (slow MCP server — excluded this turn)`);
      void attempts[i]?.then(() => {
        const late = slots[i]?.result;
        if (late) {
          late.cleanup?.();
          void late.client.close().catch(() => {});
        }
      });
    }
  }

  // Surface (not swallow) any server that didn't make it — never silently
  // degrade to "builtins only" without a trace.
  if (errors.length > 0) {
    console.error(`[MCP] ${errors.length} server(s) unavailable this turn: ${errors.join(" | ")}`);
  }

  return {
    tools,
    errors,
    needsKey,
    async close() {
      for (const fn of cleanups) fn();
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
