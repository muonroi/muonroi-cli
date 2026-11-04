import { auth } from "@ai-sdk/mcp";
import { logger } from "../utils/logger.js";
import { openUrl } from "../utils/open-url.js";
import type { McpServerConfig } from "../utils/settings.js";
import { warmMcpClients } from "./client-pool.js";
import { createOAuthProviderWithCallback } from "./oauth-provider.js";

/**
 * Explicit OAuth sign-in for one remote MCP server (the /mcp modal's ctrl+o).
 * Drops any stored tokens first, so it doubles as "re-authenticate", then opens
 * the authorization page. The loopback callback server finishes the code
 * exchange in the background and warms the client so the next turn has the tools.
 */
export async function signInMcpOAuth(server: McpServerConfig): Promise<"authorized" | "browser"> {
  if (server.transport === "stdio" || !server.url) {
    throw new Error(`${server.label} is a stdio server — OAuth only applies to http/sse servers`);
  }
  const url = server.url;
  const { provider, close } = await createOAuthProviderWithCallback({
    serverId: server.id,
    serverUrl: url,
    onAuthorizationUrl: (authUrl) => {
      if (!openUrl(authUrl)) {
        logger.warn("mcp", `could not open a browser; open this URL manually: ${authUrl.toString()}`, {
          serverId: server.id,
        });
      }
    },
    onAuthorized: (result) => {
      close();
      if (!result.ok) return;
      warmMcpClients([server]).catch((err: unknown) => {
        logger.warn("mcp", `post-OAuth warmup failed: ${(err as Error)?.message}`, { serverId: server.id });
      });
    },
  });

  provider.invalidateCredentials("tokens");
  provider.invalidateCredentials("verifier");
  try {
    const result = await auth(provider as never, { serverUrl: url });
    if (result === "AUTHORIZED") {
      close();
      return "authorized";
    }
    return "browser";
  } catch (err) {
    close();
    logger.error("mcp", `oauth sign-in failed: ${(err as Error)?.message}`, { serverId: server.id, url });
    throw err;
  }
}
