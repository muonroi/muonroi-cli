import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth } from "@ai-sdk/mcp";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { logger } from "../utils/logger.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

interface CliOAuthStorage {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
}

/**
 * Tokens + DCR client registration persist across processes so the browser
 * round-trip happens once per server, not once per launch. The file holds
 * bearer/refresh tokens, so it is written 0600 under ~/.muonroi-cli.
 */
function storePath(): string {
  return join(homedir(), ".muonroi-cli", "mcp-oauth.json");
}

function readAll(): Record<string, CliOAuthStorage> {
  const file = storePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, CliOAuthStorage>;
  } catch (err) {
    logger.warn("mcp", `oauth store unreadable, starting empty: ${(err as Error)?.message}`, { file });
    return {};
  }
}

function getStore(serverId: string): CliOAuthStorage {
  return readAll()[serverId] ?? {};
}

function patchStore(serverId: string, patch: Partial<CliOAuthStorage>): void {
  const file = storePath();
  const all = readAll();
  all[serverId] = { ...(all[serverId] ?? {}), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.error("mcp", `oauth store write failed: ${(err as Error)?.message}`, { file, serverId });
  }
}

export class CliOAuthProvider {
  private serverId: string;
  private _redirectUrl: string;
  private onAuthUrl: (url: URL) => void;

  constructor(opts: {
    serverId: string;
    callbackPort: number;
    onAuthorizationUrl: (url: URL) => void;
  }) {
    this.serverId = opts.serverId;
    this._redirectUrl = `http://127.0.0.1:${opts.callbackPort}/callback`;
    this.onAuthUrl = opts.onAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "muonroi-cli",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = getStore(this.serverId).clientInfo as
      | (OAuthClientInformationMixed & { redirect_uris?: string[] })
      | undefined;
    // The callback port is OS-assigned per process; a registration made on a
    // different port would be rejected at /authorize, so re-register instead.
    if (info?.redirect_uris && !info.redirect_uris.includes(this._redirectUrl)) return undefined;
    return info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    patchStore(this.serverId, { clientInfo: info });
  }

  tokens(): OAuthTokens | undefined {
    return getStore(this.serverId).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    patchStore(this.serverId, { tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    patchStore(this.serverId, { codeVerifier });
  }

  codeVerifier(): string {
    return getStore(this.serverId).codeVerifier ?? "";
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    patchStore(this.serverId, { discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return getStore(this.serverId).discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const patch: Partial<CliOAuthStorage> = {};
    if (scope === "all" || scope === "tokens") patch.tokens = undefined;
    if (scope === "all" || scope === "client") patch.clientInfo = undefined;
    if (scope === "all" || scope === "discovery") patch.discovery = undefined;
    if (scope === "all" || scope === "verifier") patch.codeVerifier = undefined;
    patchStore(this.serverId, patch);
  }

  cleanup(): void {
    // noop — callback server is managed externally
  }
}

export async function createOAuthProviderWithCallback(opts: {
  serverId: string;
  /** MCP endpoint URL — needed to exchange the authorization code for tokens. */
  serverUrl: string;
  onAuthorizationUrl: (url: URL) => void;
  /** Fired after the code exchange finished (tokens persisted) or failed. */
  onAuthorized?: (result: { ok: true } | { ok: false; error: string }) => void;
}): Promise<{ provider: CliOAuthProvider; close: () => void }> {
  let provider: CliOAuthProvider | undefined;
  const server = await startOAuthCallbackServer({
    onCode: (code, state) => {
      // The SDK does NOT exchange the code on its own: the 401 path in
      // @ai-sdk/mcp ends in UnauthorizedError once the browser is launched.
      // Finish the flow here so the next connect finds persisted tokens.
      if (!provider) return;
      auth(provider as never, { serverUrl: opts.serverUrl, authorizationCode: code, callbackState: state })
        .then((result) => {
          logger.info("mcp", `oauth code exchange: ${result}`, { serverId: opts.serverId });
          opts.onAuthorized?.(result === "AUTHORIZED" ? { ok: true } : { ok: false, error: String(result) });
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          logger.error("mcp", `oauth code exchange failed: ${error}`, { serverId: opts.serverId });
          opts.onAuthorized?.({ ok: false, error });
        });
    },
  });

  provider = new CliOAuthProvider({
    serverId: opts.serverId,
    callbackPort: server.port,
    onAuthorizationUrl: opts.onAuthorizationUrl,
  });

  return {
    provider,
    close() {
      server.close();
      provider?.cleanup();
    },
  };
}

/**
 * True when the endpoint answers an unauthenticated initialize with 401 — the
 * signal that OAuth is required. Probed up front because the SDK transport
 * fires one auth() per concurrent 401 (POST + SSE GET), and each registers its
 * own client and PKCE verifier, so two browser tabs open and only the last
 * verifier is valid. Servers that never 401 (no auth) skip OAuth entirely.
 */
export async function endpointRequiresOAuth(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "muonroi-cli", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel();
    return res.status === 401;
  } catch (err) {
    logger.warn("mcp", `oauth probe failed: ${(err as Error)?.message}`, { url });
    return false;
  }
}

/** Run the interactive flow once, up front. Throws with the next step when sign-in is pending. */
export async function ensureOAuthSignedIn(
  provider: CliOAuthProvider,
  server: { label: string; url: string; headers?: Record<string, string> },
): Promise<void> {
  if (provider.tokens()) return;
  if (!(await endpointRequiresOAuth(server.url, server.headers))) return;
  const result = await auth(provider as never, { serverUrl: server.url });
  if (result !== "AUTHORIZED") {
    throw new Error(
      `${server.label} needs OAuth sign-in — finish it in the browser window that just opened, then retry (tokens are saved to ~/.muonroi-cli/mcp-oauth.json)`,
    );
  }
}
