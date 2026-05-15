/**
 * src/providers/auth/openai-oauth.ts
 *
 * OpenAI Device-Code + PKCE OAuth implementation.
 *
 * Uses Codex CLI's published client_id (OSS MIT license, public):
 *   client_id = "app_EMznDTI27GiqE5Cz4yviqixP"
 *   Source: https://github.com/openai/codex (oauth config)
 * Rationale: zero registration friction; already proven to work with
 * OpenAI subscription accounts (ChatGPT Plus/Pro/Team).
 *
 * NOTE: this is NOT CliOAuthProvider (src/mcp/oauth-provider.ts) which uses
 * a browser-redirect flow for MCP. This is a different device-code grant.
 */

import type { FetchFn } from "./device-flow.js";
import { exchangeCodeForTokens, generatePKCE, pollDeviceAuthorization, requestDeviceCode } from "./device-flow.js";
import type { OAuthTokens, ProviderOAuth, TokenExchangeResponse, UserInfo } from "./types.js";
import { OAuthLoginError, OAuthRefreshError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_ISSUER = "https://auth.openai.com";

/**
 * Codex CLI's published OAuth client_id.
 * Legal to use: MIT-licensed open-source, publicly documented.
 */
const OPENAI_CLIENT_ID = "app_EMznDTI27GiqE5Cz4yviqixP";

// Pre-emptive refresh window: refresh when token expires within 60 seconds.
const REFRESH_WINDOW_MS = 60_000;

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
// OpenAIOAuthProvider
// ---------------------------------------------------------------------------

export class OpenAIOAuthProvider implements ProviderOAuth {
  readonly providerId = "openai" as const;

  private readonly issuer: string;
  private readonly clientId: string;
  private readonly fetchFn: FetchFn;
  private readonly mutex = new Mutex();

  constructor(opts: { issuer?: string; clientId?: string; fetchFn?: FetchFn } = {}) {
    this.issuer = opts.issuer ?? OPENAI_ISSUER;
    this.clientId = opts.clientId ?? OPENAI_CLIENT_ID;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(opts: { onUserCode?: (code: string, url: string) => void } = {}): Promise<OAuthTokens> {
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Step 1: request device code
    let deviceResponse: Awaited<ReturnType<typeof requestDeviceCode>>;
    try {
      deviceResponse = await requestDeviceCode({
        issuer: this.issuer,
        clientId: this.clientId,
        codeChallenge,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      throw new OAuthLoginError("openai", String(err));
    }

    // Step 2: surface user code to caller
    opts.onUserCode?.(deviceResponse.user_code, deviceResponse.verification_uri);

    // Step 3: poll until approved
    let pollResult: Awaited<ReturnType<typeof pollDeviceAuthorization>>;
    try {
      pollResult = await pollDeviceAuthorization({
        issuer: this.issuer,
        deviceCode: deviceResponse.device_code,
        pollIntervalMs: (deviceResponse.interval ?? 3) * 1000,
        timeoutMs: (deviceResponse.expires_in ?? 300) * 1000,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      throw new OAuthLoginError("openai", String(err));
    }

    // Step 4: exchange code for tokens
    let exchangeResponse: TokenExchangeResponse;
    try {
      exchangeResponse = await exchangeCodeForTokens({
        issuer: this.issuer,
        clientId: this.clientId,
        authorizationCode: pollResult.authorization_code,
        codeVerifier,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      throw new OAuthLoginError("openai", String(err));
    }

    const expiresAt = Date.now() + (exchangeResponse.expires_in ?? 3600) * 1000;

    // Step 5: fetch userinfo (best-effort)
    let email: string | undefined;
    try {
      email = await this._fetchUserEmail(exchangeResponse.access_token);
    } catch {
      // non-fatal
    }

    return {
      accessToken: exchangeResponse.access_token,
      refreshToken: exchangeResponse.refresh_token,
      idToken: exchangeResponse.id_token,
      accountId: exchangeResponse.account_id,
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
      // Double-check after acquiring lock — another concurrent call may have
      // already refreshed.
      if (tokens.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
        return tokens;
      }

      const res = await this.fetchFn(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: this.clientId,
          refresh_token: tokens.refreshToken,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "(unreadable)");
        // invalid_grant = permanent failure
        if (res.status === 400 || res.status === 401) {
          throw new OAuthRefreshError("openai", `${res.status}: ${text}`);
        }
        throw new OAuthRefreshError("openai", `HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as TokenExchangeResponse;
      const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        idToken: data.id_token ?? tokens.idToken,
        accountId: data.account_id ?? tokens.accountId,
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
      await this.fetchFn(`${this.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          token: tokens.refreshToken,
        }),
      });
    } catch {
      // best-effort — caller should delete local tokens regardless
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
// Singleton
// ---------------------------------------------------------------------------

/** Default OpenAI OAuth provider singleton (uses live auth.openai.com). */
export const openAIOAuth = new OpenAIOAuthProvider();

// ---------------------------------------------------------------------------
// Convenience: load + auto-refresh tokens
// ---------------------------------------------------------------------------

/**
 * Load stored OAuth tokens for OpenAI and auto-refresh if within the expiry
 * window. Returns null if no tokens are stored.
 *
 * Uses a module-level mutex to prevent concurrent refresh races.
 */
export async function loadTokensWithRefresh(
  provider: "openai",
  oauthProvider?: OpenAIOAuthProvider,
): Promise<OAuthTokens | null> {
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens(provider);
  if (!tokens) return null;

  const impl = oauthProvider ?? openAIOAuth;

  // Pre-emptive refresh
  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      tokens = await impl.refresh(tokens);
      await saveTokens(provider, tokens);
    } catch {
      // If refresh fails, return stale tokens — adapter will get 401 and
      // the user will need to re-login.
    }
  }

  return tokens;
}
