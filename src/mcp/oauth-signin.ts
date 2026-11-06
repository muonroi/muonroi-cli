import { logger } from "../utils/logger.js";
import { openUrl } from "../utils/open-url.js";
import type { McpServerConfig } from "../utils/settings.js";
import { warmMcpClients } from "./client-pool.js";
import { beginMcpOAuthSignIn, type McpOAuthSignInOutcome } from "./oauth-provider.js";

export interface McpOAuthSignInResult {
  status: "authorized" | "browser" | "pending";
  /** The authorization URL, so the UI can show it when no browser could be opened. */
  authUrl?: string;
  /** Whether a browser was launched for `authUrl`. */
  browserOpened: boolean;
  /** Settles once the callback finished the code exchange (or failed / timed out). */
  completion: Promise<McpOAuthSignInOutcome>;
}

/**
 * Explicit OAuth sign-in for one remote MCP server (the /mcp modal's ctrl+o).
 * Drops any stored tokens first, so it doubles as "re-authenticate", then opens
 * the authorization page. The loopback callback server finishes the code
 * exchange in the background; on success the pool's auth pause is lifted (see
 * client-pool's onMcpOAuthSignedIn) and the server is re-warmed so the next
 * turn has its tools.
 */
export async function signInMcpOAuth(
  server: McpServerConfig,
  opts: { openAuthorizationUrl?: (url: URL) => boolean; timeoutMs?: number } = {},
): Promise<McpOAuthSignInResult> {
  if (server.transport === "stdio" || !server.url) {
    throw new Error(`${server.label} is a stdio server — OAuth only applies to http/sse servers`);
  }
  // MUONROI_MCP_OAUTH_NO_BROWSER=1 (SSH / headless boxes, and the harness spec):
  // never launch a browser — the /mcp toast shows the URL to open by hand.
  const noBrowser = process.env.MUONROI_MCP_OAUTH_NO_BROWSER === "1";
  const open = opts.openAuthorizationUrl ?? ((url: URL) => (noBrowser ? false : openUrl(url)));
  let browserOpened = false;
  try {
    const started = await beginMcpOAuthSignIn(
      { id: server.id, label: server.label, url: server.url },
      {
        force: true,
        timeoutMs: opts.timeoutMs,
        openAuthorizationUrl: (authUrl) => {
          browserOpened = open(authUrl);
          if (!browserOpened) {
            logger.warn("mcp", `could not open a browser; open this URL manually: ${authUrl.toString()}`, {
              serverId: server.id,
            });
          }
        },
      },
    );
    const completion = started.completion.then((outcome) => {
      if (outcome.ok) {
        warmMcpClients([server]).catch((err: unknown) => {
          logger.warn("mcp", `post-OAuth warmup failed: ${(err as Error)?.message}`, { serverId: server.id });
        });
      }
      return outcome;
    });
    return { status: started.status, authUrl: started.authUrl?.toString(), browserOpened, completion };
  } catch (err) {
    logger.error("mcp", `oauth sign-in failed: ${(err as Error)?.message}`, { serverId: server.id, url: server.url });
    throw err;
  }
}
