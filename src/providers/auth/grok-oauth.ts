/**
 * src/providers/auth/grok-oauth.ts
 *
 * xAI / Grok subscription OAuth — Authorization Code + PKCE with loopback
 * redirect (SuperGrok / X Premium+). No XAI_API_KEY required: the user logs in
 * once via accounts/auth.x.ai and the access token is used as a Bearer against
 * the standard xAI API base (https://api.x.ai/v1), which is OpenAI-compatible
 * and accepts the token on both /chat/completions and /responses.
 *
 * Flow (mirrors gemini-oauth.ts, with xAI-specific authorize params):
 *   1. Spawn a loopback HTTP server (OS-assigned port — xAI's OAuth client
 *      allows arbitrary 127.0.0.1 ports per RFC 8252; pi-grok confirms this
 *      with its listen(0) fallback).
 *   2. Open the browser at https://auth.x.ai/oauth2/authorize with PKCE S256,
 *      plus xAI extras (`plan=generic` selects the subscription tier,
 *      `referrer` is a free-text client tag, `nonce` for OIDC).
 *   3. User signs in; xAI redirects back to the loopback URL with ?code&state.
 *   4. POST /oauth2/token (grant_type=authorization_code + code_verifier) for
 *      access/refresh tokens. Public client — no client_secret (PKCE only).
 *
 * client_id: a shared public xAI desktop OAuth client (NOT a secret — RFC 8252
 * native clients embed it in public bundles by design). Same interoperability
 * pattern as the published Codex CLI client_id used in openai-oauth.ts. Sourced
 * from the MIT-licensed pi-grok OSS project and cross-checked against the live
 * xAI OIDC discovery document; override via MUONROI_XAI_CLIENT_ID.
 */

import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { OAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { startOAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { exchangeBrowserCode, generatePKCE, refreshBrowserTokens } from "./browser-flow.js";
import type { FetchFn } from "./device-flow.js";
import type { OAuthTokens, ProviderOAuth } from "./types.js";
import { OAuthLoginError, OAuthRefreshError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_ISSUER = "https://auth.x.ai";

/**
 * Shared public xAI desktop OAuth client_id (see file header). Override via
 * MUONROI_XAI_CLIENT_ID. Rotate when xAI rotates the shared client.
 */
const XAI_CLIENT_ID = process.env.MUONROI_XAI_CLIENT_ID ?? "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * Scopes accepted by xAI's OAuth client (every entry is in the live discovery
 * `scopes_supported`): `grok-cli:access` + `api:access` grant API access on the
 * subscription, `offline_access` yields a refresh token.
 */
const XAI_SCOPES = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"];

/** Selects xAI's generic OAuth plan tier (subscription-tier selection param). */
const XAI_PLAN = "generic";
/** Free-text client identifier sent on the authorize request (not auth-significant). */
const XAI_REFERRER = "muonroi-cli";

// Pre-emptive refresh window: refresh when the token expires within 60 seconds.
const REFRESH_WINDOW_MS = 60_000;
// Loopback callback timeout: 5 minutes for the user to complete browser login.
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Injected dependencies (for testability)
// ---------------------------------------------------------------------------

export type CallbackServerFn = (opts: {
  onCode: (code: string, state: string) => void;
  timeoutMs?: number;
}) => Promise<OAuthCallbackServer>;

export type OpenBrowserFn = (url: string) => void;

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {
    // fire-and-forget — errors non-fatal (user can open the URL manually)
  });
}

// ---------------------------------------------------------------------------
// Mutex — prevents double-refresh under concurrent requests
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
// GrokOAuthProvider
// ---------------------------------------------------------------------------

export class GrokOAuthProvider implements ProviderOAuth {
  readonly providerId = "xai" as const;

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
    this.issuer = opts.issuer ?? XAI_ISSUER;
    this.clientId = opts.clientId ?? XAI_CLIENT_ID;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.callbackServerFn = opts.callbackServerFn ?? startOAuthCallbackServer;
    this.openBrowserFn = opts.openBrowserFn ?? defaultOpenBrowser;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(opts: { onUserCode?: (code: string, url: string) => void } = {}): Promise<OAuthTokens> {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");

    let callbackServer: OAuthCallbackServer | undefined;
    let authCode: string;
    let receivedState = "";

    try {
      authCode = await new Promise<string>((resolve, reject) => {
        const loginTimeout = setTimeout(() => {
          reject(new Error("OAuth browser callback timed out"));
        }, CALLBACK_TIMEOUT_MS);

        this.callbackServerFn({
          onCode: (code: string, s: string) => {
            receivedState = s;
            clearTimeout(loginTimeout);
            resolve(code);
          },
          timeoutMs: CALLBACK_TIMEOUT_MS,
        })
          .then((server) => {
            callbackServer = server;
            const authorizeUrl = buildXAIAuthorizeUrl({
              authEndpoint: `${this.issuer}/oauth2/authorize`,
              clientId: this.clientId,
              redirectUri: server.url,
              scopes: XAI_SCOPES,
              codeChallenge,
              state,
              nonce,
            });
            opts.onUserCode?.(authorizeUrl, authorizeUrl);
            this.openBrowserFn(authorizeUrl);
          })
          .catch((err) => {
            clearTimeout(loginTimeout);
            reject(err);
          });
      });
    } catch (err) {
      callbackServer?.close();
      throw new OAuthLoginError("xai", String(err));
    } finally {
      callbackServer?.close();
    }

    if (receivedState && receivedState !== state) {
      throw new OAuthLoginError("xai", "OAuth state mismatch — possible CSRF, aborting.");
    }

    let tokenResponse: Awaited<ReturnType<typeof exchangeBrowserCode>>;
    try {
      tokenResponse = await exchangeBrowserCode({
        tokenEndpoint: `${this.issuer}/oauth2/token`,
        clientId: this.clientId,
        redirectUri: callbackServer?.url ?? "",
        code: authCode,
        codeVerifier,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      throw new OAuthLoginError("xai", String(err));
    }

    const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;
    const email = extractIdTokenClaim<string>(tokenResponse.id_token, "email");

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? "",
      idToken: tokenResponse.id_token,
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

      let data: Awaited<ReturnType<typeof refreshBrowserTokens>>;
      try {
        data = await refreshBrowserTokens({
          tokenEndpoint: `${this.issuer}/oauth2/token`,
          clientId: this.clientId,
          refreshToken: tokens.refreshToken,
          fetchFn: this.fetchFn,
        });
      } catch (err) {
        throw new OAuthRefreshError("xai", String(err));
      }

      const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
      return {
        accessToken: data.access_token,
        // xAI may not rotate refresh tokens — fall back to the existing one.
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        idToken: data.id_token ?? tokens.idToken,
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
      const body = new URLSearchParams({ client_id: this.clientId, token });
      await this.fetchFn(`${this.issuer}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // best-effort — caller deletes local tokens regardless
    }
  }

  // -------------------------------------------------------------------------
  // authHeaders
  // -------------------------------------------------------------------------

  authHeaders(tokens: OAuthTokens): Record<string, string> {
    // xAI uses a plain Bearer token — no account-id header (unlike OpenAI's
    // ChatGPT-Account-ID).
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }
}

// ---------------------------------------------------------------------------
// Authorize URL builder — xAI-specific params (no Google access_type/prompt).
// ---------------------------------------------------------------------------

interface XAIAuthorizeUrlOpts {
  authEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string;
  nonce: string;
}

function buildXAIAuthorizeUrl(opts: XAIAuthorizeUrlOpts): string {
  // Build the query string by hand — the generic buildAuthorizeUrl() injects
  // Google-specific params (access_type=offline, prompt=consent) that xAI's
  // auth backend does not expect.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
    nonce: opts.nonce,
    plan: XAI_PLAN,
    referrer: XAI_REFERRER,
  });
  return `${opts.authEndpoint}?${params.toString()}`;
}

/**
 * Decode the JWT payload (middle segment) and return a top-level claim.
 * Returns undefined for malformed / missing tokens — email is best-effort and
 * the login flow does not fail without it.
 */
function extractIdTokenClaim<T>(idToken: string | undefined, key: string): T | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return (JSON.parse(payload) as Record<string, unknown>)[key] as T | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Default Grok OAuth provider singleton (uses live xAI endpoints). */
export const grokOAuth = new GrokOAuthProvider();

// ---------------------------------------------------------------------------
// Convenience: load + auto-refresh tokens
// ---------------------------------------------------------------------------

/**
 * Load stored xAI OAuth tokens and auto-refresh if within the expiry window.
 * Returns null if no tokens are stored.
 */
export async function loadGrokTokensWithRefresh(oauthProvider?: GrokOAuthProvider): Promise<OAuthTokens | null> {
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens("xai");
  if (!tokens) return null;

  const impl = oauthProvider ?? grokOAuth;

  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      tokens = await impl.refresh(tokens);
      await saveTokens("xai", tokens);
    } catch {
      // Return stale tokens — the adapter will get a 401 on the real request.
    }
  }

  return tokens;
}
