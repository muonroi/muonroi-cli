import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings.js";
import { validateMcpServerConfig } from "./validate.js";
import { createOAuthProviderWithCallback } from "./oauth-provider.js";

function mcpToolPrefix(server: McpServerConfig): string {
  return `mcp_${server.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function toTransport(
  server: McpServerConfig,
  authProvider?: OAuthClientProvider,
) {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args,
      env: server.env
        ? { ...getDefaultEnvironment(), ...server.env }
        : undefined,
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

export async function buildMcpToolSet(
  servers: McpServerConfig[],
  opts?: McpBuildOptions,
): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];
  const cleanups: (() => void)[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      errors.push(`${server.label}: ${validation.error}`);
      continue;
    }

    try {
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
        tools[prefixedName] = {
          ...tool,
          description: `[MCP ${server.label}] ${tool.description ?? name}`,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${server.label}: ${message}`);
    }
  }

  return {
    tools,
    errors,
    async close() {
      for (const fn of cleanups) fn();
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
    },
  };
}
