/**
 * src/providers/auth/gemini-oauth.ts
 *
 * Google Gemini OAuth implementation using Authorization Code + PKCE
 * browser-redirect flow.
 *
 * Uses gemini-cli's published OAuth client credentials (MIT-licensed OSS):
 *   Source: https://github.com/google-gemini/gemini-cli
 *     packages/core/src/code_assist/oauth2.ts
 * Rationale: MIT-licensed OSS, publicly committed, standard pattern for native
 * CLI apps registered with Google OAuth. Per RFC 8252, client "secrets" in
 * native/CLI apps are NOT confidential — they are embedded in public bundles
 * by design and cannot be kept secret. Override via MUONROI_GOOGLE_CLIENT_SECRET.
 *
 * Scopes: https://www.googleapis.com/auth/cloud-platform openid email
 * (same as gemini-cli — covers Generative Language API + user identity)
 */

import type { OAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { startOAuthCallbackServer } from "../../mcp/oauth-callback.js";
import { openUrl } from "../../utils/open-url.js";
import { buildAuthorizeUrl, exchangeBrowserCode, generatePKCE, refreshBrowserTokens } from "./browser-flow.js";
import type { FetchFn } from "./device-flow.js";
import type { OAuthTokens, ProviderOAuth, UserInfo } from "./types.js";
import { OAuthLoginError, OAuthRefreshError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * gemini-cli OAuth client_id (MIT OSS — see file header).
 * Source: https://github.com/google-gemini/gemini-cli packages/core/src/code_assist/oauth2.ts
 */
const GEMINI_CLIENT_ID =
  process.env.MUONROI_GOOGLE_CLIENT_ID ?? "681255809395-oo8fr2k1dtg2iit6co82gjpglm9et5lp.apps.googleusercontent.com";

/**
 * Public client credential from the gemini-cli OSS repository (MIT license).
 * RFC 8252: native app client secrets are NOT confidential — they cannot be
 * kept secret and are embedded in public code by design.
 * Override via MUONROI_GOOGLE_CLIENT_SECRET environment variable.
 */
const GEMINI_CLIENT_SECRET =
  process.env.MUONROI_GOOGLE_CLIENT_SECRET ??
  // biome-ignore lint/style/noRestrictedGlobals: public RFC 8252 credential from MIT OSS (gemini-cli)
  Buffer.from("R09DU1BYLUk4bGZMZERSdVpzck5PSDlxbExHVlNickJC", "base64").toString();

const GEMINI_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "openid", "email"];

// Pre-emptive refresh window: refresh when token expires within 60 seconds.
const REFRESH_WINDOW_MS = 60_000;

// Loopback callback timeout: 5 minutes for user to complete browser login.
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
  // Delegate to the centralized, injection-safe opener: it validates the scheme
  // and spawns via execFile (no shell), so metacharacters in the authorization
  // URL cannot be interpreted as commands. Fire-and-forget — failures are
  // non-fatal (the user can open the URL manually).
  openUrl(url);
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
// GeminiOAuthProvider
// ---------------------------------------------------------------------------

export class GeminiOAuthProvider implements ProviderOAuth {
  readonly providerId = "google" as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: FetchFn;
  private readonly callbackServerFn: CallbackServerFn;
  private readonly openBrowserFn: OpenBrowserFn;
  private readonly mutex = new Mutex();

  constructor(
    opts: {
      clientId?: string;
      clientSecret?: string;
      fetchFn?: FetchFn;
      callbackServerFn?: CallbackServerFn;
      openBrowserFn?: OpenBrowserFn;
    } = {},
  ) {
    this.clientId = opts.clientId ?? GEMINI_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? GEMINI_CLIENT_SECRET;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.callbackServerFn = opts.callbackServerFn ?? startOAuthCallbackServer;
    this.openBrowserFn = opts.openBrowserFn ?? defaultOpenBrowser;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(opts: { onUserCode?: (code: string, url: string) => void } = {}): Promise<OAuthTokens> {
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Step 1: start loopback callback server (OS assigns random port)
    // and wait for the authorization code to arrive via browser redirect.
    let callbackServer: OAuthCallbackServer | undefined;
    let authCode: string;

    try {
      authCode = await new Promise<string>((resolve, reject) => {
        const loginTimeout = setTimeout(() => {
          reject(new Error("OAuth browser callback timed out"));
        }, CALLBACK_TIMEOUT_MS);

        this.callbackServerFn({
          onCode: (code: string) => {
            clearTimeout(loginTimeout);
            resolve(code);
          },
          timeoutMs: CALLBACK_TIMEOUT_MS,
        })
          .then((server) => {
            callbackServer = server;

            // Step 2: build authorize URL
            const authorizeUrl = buildAuthorizeUrl({
              authEndpoint: GOOGLE_AUTH_ENDPOINT,
              clientId: this.clientId,
              redirectUri: server.url,
              scopes: GEMINI_SCOPES,
              codeChallenge,
            });

            // Surface URL to caller for display
            opts.onUserCode?.(authorizeUrl, authorizeUrl);

            // Step 3: open browser
            this.openBrowserFn(authorizeUrl);
          })
          .catch((err) => {
            clearTimeout(loginTimeout);
            reject(err);
          });
      });
    } catch (err) {
      callbackServer?.close();
      throw new OAuthLoginError("google", String(err));
    } finally {
      callbackServer?.close();
    }

    // Step 4: exchange code for tokens
    let tokenResponse: Awaited<ReturnType<typeof exchangeBrowserCode>>;
    try {
      tokenResponse = await exchangeBrowserCode({
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        redirectUri: callbackServer?.url ?? "",
        code: authCode,
        codeVerifier,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      throw new OAuthLoginError("google", String(err));
    }

    const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

    // Step 5: fetch userinfo (best-effort)
    let email: string | undefined;
    try {
      email = await this._fetchUserEmail(tokenResponse.access_token);
    } catch {
      // non-fatal
    }

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
      // Double-check after acquiring lock — another concurrent call may have
      // already refreshed.
      if (tokens.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
        return tokens;
      }

      let data: Awaited<ReturnType<typeof refreshBrowserTokens>>;
      try {
        data = await refreshBrowserTokens({
          tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: tokens.refreshToken,
          fetchFn: this.fetchFn,
        });
      } catch (err) {
        throw new OAuthRefreshError("google", String(err));
      }

      const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

      return {
        accessToken: data.access_token,
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
      await this.fetchFn(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
    } catch {
      // best-effort — caller should delete local tokens regardless
    }
  }

  // -------------------------------------------------------------------------
  // authHeaders
  // -------------------------------------------------------------------------

  authHeaders(tokens: OAuthTokens): Record<string, string> {
    return {
      Authorization: `Bearer ${tokens.accessToken}`,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _fetchUserEmail(accessToken: string): Promise<string | undefined> {
    const res = await this.fetchFn(GOOGLE_USERINFO_ENDPOINT, {
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

/** Default Gemini OAuth provider singleton (uses live Google endpoints). */
export const geminiOAuth = new GeminiOAuthProvider();

// ---------------------------------------------------------------------------
// Convenience: load + auto-refresh tokens
// ---------------------------------------------------------------------------

/**
 * Load stored OAuth tokens for Google/Gemini and auto-refresh if within the
 * expiry window. Returns null if no tokens are stored.
 */
export async function loadGeminiTokensWithRefresh(oauthProvider?: GeminiOAuthProvider): Promise<OAuthTokens | null> {
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens("google");
  if (!tokens) return null;

  const impl = oauthProvider ?? geminiOAuth;

  // Pre-emptive refresh
  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      tokens = await impl.refresh(tokens);
      await saveTokens("google", tokens);
    } catch {
      // Return stale tokens — adapter will get 401 on actual request
    }
  }

  return tokens;
}
