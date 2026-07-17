/**
 * src/providers/auth/openai-oauth.ts
 *
 * OpenAI subscription OAuth — Authorization Code + PKCE with loopback redirect.
 *
 * Mirrors the official Codex CLI flow (https://github.com/openai/codex,
 * codex-rs/login/src/server.rs):
 *   1. Spawn a local HTTP server on port 1455 (fallback 1457). The port is
 *      fixed because OpenAI's OAuth app has `http://localhost:1455/auth/callback`
 *      registered as the allowed redirect_uri — random ports are rejected.
 *   2. Open the user's browser at https://auth.openai.com/oauth/authorize with
 *      response_type=code, PKCE S256, and Codex-specific extras.
 *   3. The user logs in via the real ChatGPT login page; OpenAI redirects
 *      back to the loopback URL with ?code=...&state=...
 *   4. POST /oauth/token with grant_type=authorization_code + code_verifier
 *      to obtain access/refresh tokens.
 *
 * Uses Codex CLI's published client_id (MIT-licensed OSS, RFC 8252 — public
 * client, no confidential secret):
 *   client_id = "app_EMznDTI27GiqE5Cz4yviqixP"
 *
 * NOTE: this is NOT CliOAuthProvider (src/mcp/oauth-provider.ts) which serves
 * the MCP server-discovery OAuth dance.
 */

import { randomBytes } from "node:crypto";
import type { OAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { startOAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { openUrl } from "../../utils/open-url.js";
import { exchangeBrowserCode, generatePKCE, refreshBrowserTokens } from "./browser-flow.js";
import type { FetchFn } from "./device-flow.js";
import type { OAuthTokens, ProviderOAuth, UserInfo } from "./types.js";
import { OAuthLoginError, OAuthRefreshError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_ISSUER = "https://auth.openai.com";

/**
 * Codex CLI's published OAuth client_id (MIT OSS, RFC 8252 public client).
 * Source: openai/codex codex-rs/login/src/auth/manager.rs `pub const CLIENT_ID`.
 * Rotate this when Codex rotates theirs (the prior id was app_EMznDTI27GiqE5Cz4yviqixP).
 */
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * Codex CLI's registered redirect ports. OpenAI's OAuth app rejects
 * redirect_uri values that don't match these literally.
 */
const CODEX_PORTS = [1455, 1457] as const;
const CALLBACK_PATH = "/auth/callback";

// Scopes must match Codex CLI exactly — OpenAI's OAuth app config rejects
// requests that ask for a different scope set than what's registered.
const OPENAI_SCOPES = ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"];

/** Identifies the calling CLI to OpenAI's auth backend. Required. */
const OPENAI_ORIGINATOR = "codex_cli_rs";

const REFRESH_WINDOW_MS = 60_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Injected dependencies (for testability)
// ---------------------------------------------------------------------------

export type CallbackServerFn = (opts: {
  onCode: (code: string, state: string) => void;
  timeoutMs?: number;
  port?: number;
  path?: string;
  host?: string;
}) => Promise<OAuthCallbackServer>;

export type OpenBrowserFn = (url: string) => void;

function defaultOpenBrowser(url: string): void {
  // Delegate to the centralized, injection-safe opener: it validates the scheme
  // and spawns via execFile (no shell), so metacharacters in the authorization
  // URL cannot be interpreted as commands. Fire-and-forget — failures are
  // non-fatal (the user can open the URL manually).
  openUrl(url);
}

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise((resolve) => {
      this._queue.push(() => {
        this._locked = true;
        resolve(() => this._release());
      });
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAIOAuthProvider
// ---------------------------------------------------------------------------

export class OpenAIOAuthProvider implements ProviderOAuth {
  readonly providerId = "openai" as const;

  private readonly issuer: string;
  private readonly clientId: string;
  private readonly fetchFn: FetchFn;
  private readonly callbackServerFn: CallbackServerFn;
  private readonly openBrowserFn: OpenBrowserFn;
  private readonly mutex = new Mutex();

  constructor(
    opts: {
      issuer?: string;
      clientId?: string;
      fetchFn?: FetchFn;
      callbackServerFn?: CallbackServerFn;
      openBrowserFn?: OpenBrowserFn;
    } = {},
  ) {
    this.issuer = opts.issuer ?? OPENAI_ISSUER;
    this.clientId = opts.clientId ?? OPENAI_CLIENT_ID;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.callbackServerFn = opts.callbackServerFn ?? startOAuthCallbackServer;
    this.openBrowserFn = opts.openBrowserFn ?? defaultOpenBrowser;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(
    opts: { onUserCode?: (code: string, url: string) => void; signal?: AbortSignal } = {},
  ): Promise<OAuthTokens> {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = randomBytes(16).toString("base64url");

    let authCode: string;
    let receivedState = "";
    let bound: OAuthCallbackServer | undefined;

    try {
      authCode = await new Promise<string>((resolve, reject) => {
        const loginTimeout = setTimeout(() => {
          reject(new Error("OAuth browser callback timed out"));
        }, CALLBACK_TIMEOUT_MS);

        // Cancelling used to abandon this promise rather than end it: the
        // loopback server then held its port for the full CALLBACK_TIMEOUT_MS
        // (5 min) across only two ports, so the next sign-in could not bind and
        // the user had to restart the CLI. Rejecting here runs the `finally`
        // below, which closes the server and frees the port immediately.
        const onAbort = () => {
          clearTimeout(loginTimeout);
          reject(new OAuthLoginError("openai", "Sign-in cancelled."));
        };
        if (opts.signal?.aborted) {
          onAbort();
          return;
        }
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        const tryPorts = async () => {
          let bindError: unknown;
          for (const port of CODEX_PORTS) {
            try {
              const server = await this.callbackServerFn({
                onCode: (code, s) => {
                  receivedState = s;
                  clearTimeout(loginTimeout);
                  resolve(code);
                },
                port,
                path: CALLBACK_PATH,
                host: "localhost",
                timeoutMs: CALLBACK_TIMEOUT_MS,
              });
              bound = server;

              const authorizeUrl = buildOpenAIAuthorizeUrl({
                authEndpoint: `${this.issuer}/oauth/authorize`,
                clientId: this.clientId,
                redirectUri: server.url,
                scopes: OPENAI_SCOPES,
                codeChallenge,
                state,
              });

              opts.onUserCode?.(authorizeUrl, authorizeUrl);
              this.openBrowserFn(authorizeUrl);
              return;
            } catch (err) {
              bindError = err;
            }
          }
          clearTimeout(loginTimeout);
          reject(
            new Error(
              `Could not bind loopback callback on ports ${CODEX_PORTS.join(", ")}: ${String(bindError)}. ` +
                `Stop any other process holding that port and retry.`,
            ),
          );
        };

        tryPorts().catch((err) => {
          clearTimeout(loginTimeout);
          reject(err);
        });
      });
    } catch (err) {
      bound?.close();
      throw new OAuthLoginError("openai", String(err));
    } finally {
      bound?.close();
    }

    if (receivedState && receivedState !== state) {
      throw new OAuthLoginError("openai", "OAuth state mismatch — possible CSRF, aborting.");
    }

    // Step 2: exchange code for tokens (no client_secret — public client).
    let tokenResponse: Awaited<ReturnType<typeof exchangeBrowserCode>> & { account_id?: string };
    try {
      tokenResponse = (await exchangeBrowserCode({
        tokenEndpoint: `${this.issuer}/oauth/token`,
        clientId: this.clientId,
        redirectUri: bound?.url ?? `http://localhost:${CODEX_PORTS[0]}${CALLBACK_PATH}`,
        code: authCode,
        codeVerifier,
        fetchFn: this.fetchFn,
      })) as Awaited<ReturnType<typeof exchangeBrowserCode>> & { account_id?: string };
    } catch (err) {
      throw new OAuthLoginError("openai", String(err));
    }

    const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

    // Step 3: extract email from id_token (cheaper than the /userinfo HTTP
    // round-trip) and fall back to userinfo only if the claim is missing.
    let email = extractIdTokenClaim<string>(tokenResponse.id_token, "email");
    if (!email) {
      try {
        email = await this._fetchUserEmail(tokenResponse.access_token);
      } catch {
        // non-fatal
      }
    }

    // ChatGPT-Account-ID is required by chatgpt.com/backend-api/codex but
    // OpenAI's /oauth/token response does not include `account_id` as a
    // top-level field. Codex extracts it from the id_token JWT claim
    // `https://api.openai.com/auth.chatgpt_account_id`.
    const accountId = tokenResponse.account_id ?? extractChatGPTAccountId(tokenResponse.id_token);

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? "",
      idToken: tokenResponse.id_token,
      accountId,
      expiresAt,
      email,
    };
  }

  // -------------------------------------------------------------------------
  // refresh
  // -------------------------------------------------------------------------

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    const release = await this.mutex.acquire();
    try {
      if (tokens.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
        return tokens;
      }

      let data: Awaited<ReturnType<typeof refreshBrowserTokens>> & { account_id?: string };
      try {
        data = (await refreshBrowserTokens({
          tokenEndpoint: `${this.issuer}/oauth/token`,
          clientId: this.clientId,
          refreshToken: tokens.refreshToken,
          fetchFn: this.fetchFn,
        })) as Awaited<ReturnType<typeof refreshBrowserTokens>> & { account_id?: string };
      } catch (err) {
        throw new OAuthRefreshError("openai", String(err));
      }

      const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

      const accountId = data.account_id ?? extractChatGPTAccountId(data.id_token) ?? tokens.accountId;

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        idToken: data.id_token ?? tokens.idToken,
        accountId,
        expiresAt,
        email: tokens.email,
      };
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------

  async revoke(tokens: OAuthTokens): Promise<void> {
    try {
      const token = tokens.refreshToken || tokens.accessToken;
      const body = new URLSearchParams({
        client_id: this.clientId,
        token,
      });
      await this.fetchFn(`${this.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // authHeaders
  // -------------------------------------------------------------------------

  authHeaders(tokens: OAuthTokens): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    if (tokens.accountId) {
      headers["ChatGPT-Account-ID"] = tokens.accountId;
    }
    return headers;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _fetchUserEmail(accessToken: string): Promise<string | undefined> {
    const res = await this.fetchFn(`${this.issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as UserInfo;
    return info.email;
  }
}

// ---------------------------------------------------------------------------
// Authorize URL builder — adds Codex-specific extras on top of the generic
// PKCE authorize URL builder.
// ---------------------------------------------------------------------------

interface OpenAIAuthorizeUrlOpts {
  authEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string;
}

/**
 * Decode the JWT payload (middle segment) and return the OpenAI ChatGPT
 * account id claim if present. Returns undefined for malformed or missing
 * tokens — `account_id` is best-effort and the login flow doesn't fail
 * without it.
 */
function decodeIdTokenClaims(idToken: string | undefined): Record<string, unknown> | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractChatGPTAccountId(idToken: string | undefined): string | undefined {
  const claims = decodeIdTokenClaims(idToken);
  const authClaim = claims?.["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
  return authClaim?.chatgpt_account_id;
}

function extractIdTokenClaim<T>(idToken: string | undefined, key: string): T | undefined {
  return decodeIdTokenClaims(idToken)?.[key] as T | undefined;
}

function buildOpenAIAuthorizeUrl(opts: OpenAIAuthorizeUrlOpts): string {
  // Build the query string by hand — generic helpers like buildAuthorizeUrl()
  // inject extra params (access_type=offline, prompt=consent) that
  // OpenAI's auth backend rejects with "Authentication Error".
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: opts.state,
    originator: OPENAI_ORIGINATOR,
  });
  return `${opts.authEndpoint}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const openAIOAuth = new OpenAIOAuthProvider();

// ---------------------------------------------------------------------------
// Convenience: load + auto-refresh tokens
// ---------------------------------------------------------------------------

export async function loadTokensWithRefresh(
  provider: "openai",
  oauthProvider?: OpenAIOAuthProvider,
): Promise<OAuthTokens | null> {
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens(provider);
  if (!tokens) return null;

  const impl = oauthProvider ?? openAIOAuth;

  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      tokens = await impl.refresh(tokens);
      await saveTokens(provider, tokens);
    } catch {
      // stale tokens — adapter will get 401
    }
  }

  return tokens;
}
