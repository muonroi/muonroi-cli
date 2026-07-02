import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "@ai-sdk/provider-utils";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings.js";
import { capMcpToolResult } from "./cap-tool-result.js";
import { getMcpKey, type McpKeyId } from "./mcp-keychain.js";
import { createOAuthProviderWithCallback } from "./oauth-provider.js";
import { validateMcpServerConfig } from "./validate.js";

// Map MCP server id → keychain id + env var name for env hydration at spawn.
// When a server's env value is empty/missing, we look up the key from the
// OS keychain (or its env-var fallback) and inject it into the spawned process.
const MCP_ENV_HYDRATION: Record<string, { keyId: McpKeyId; envVar: string }> = {
  tavily: { keyId: "tavily", envVar: "TAVILY_API_KEY" },
};

async function hydrateServerEnv(server: McpServerConfig): Promise<McpServerConfig> {
  const hydration = MCP_ENV_HYDRATION[server.id];
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

function stripMcpInputSchema<T extends { inputSchema?: unknown; description?: string }>(tool: T): T {
  // Replace the full schema with a permissive placeholder. We keep `description`
  // and `execute` (and any other fields) intact. Many MCP tools also have an
  // `outputSchema`; we leave that alone since the AI SDK uses it only to parse
  // structured tool results — it doesn't ship to the model.
  return {
    ...tool,
    inputSchema: jsonSchema(LAZY_MCP_INPUT_SCHEMA),
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
    // Cap MCP tool output the same way built-in tools are capped so the raw
    // server payload doesn't stream into context uncapped. See cap-tool-result.ts.
    const baseExecute = (stripped as { execute?: (args: unknown, options: unknown) => Promise<unknown> }).execute;
    tools[prefixedName] = {
      ...(stripped as object),
      description: `[MCP ${server.label}] ${tool.description ?? name}`,
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
  const enabled = servers.filter((s) => s.enabled);
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
    async close() {
      for (const fn of cleanups) fn();
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
