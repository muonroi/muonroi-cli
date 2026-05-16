import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "@ai-sdk/provider-utils";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings.js";
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
const LAZY_MCP_INPUT_SCHEMA = {
  type: "object" as const,
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

function toTransport(server: McpServerConfig, authProvider?: OAuthClientProvider) {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args,
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
}

export async function buildMcpToolSet(servers: McpServerConfig[], opts?: McpBuildOptions): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];
  const cleanups: (() => void)[] = [];

  for (const rawServer of servers) {
    if (!rawServer.enabled) continue;

    const validation = validateMcpServerConfig(rawServer);
    if (!validation.ok) {
      errors.push(`${rawServer.label}: ${validation.error}`);
      continue;
    }

    try {
      // Hydrate env vars from the OS keychain before spawning — e.g. inject
      // TAVILY_API_KEY for the tavily MCP if the user stored it via the
      // research-onboarding wizard.
      const server = await hydrateServerEnv(rawServer);

      let authProvider: OAuthClientProvider | undefined;

      if (server.transport !== "stdio" && opts?.onOAuthRequired) {
        const oauthResult = await createOAuthProviderWithCallback({
          serverId: server.id,
          onAuthorizationUrl: (url: URL) => opts.onOAuthRequired!(server.id, url),
        });
        authProvider = oauthResult.provider;
        cleanups.push(oauthResult.close);
      }

      const client = await createMCPClient({
        transport: toTransport(server, authProvider),
        name: `muonroi-cli-${server.id}`,
        version: "1.0.0",
      });
      clients.push(client);

      const mcpTools = await client.tools();
      const prefix = mcpToolPrefix(server);

      for (const [name, tool] of Object.entries(mcpTools)) {
        const prefixedName = `${prefix}__${name}`;
        const stripped = stripMcpInputSchema(tool as { inputSchema?: unknown; description?: string });
        tools[prefixedName] = {
          ...(stripped as object),
          description: `[MCP ${server.label}] ${tool.description ?? name}`,
        } as ToolSet[string];
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${rawServer.label}: ${message}`);
    }
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
