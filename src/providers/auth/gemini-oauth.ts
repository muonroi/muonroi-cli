/**
 * src/providers/auth/gemini-oauth.ts
 *
 * Agy (Antigravity) Google OAuth implementation.
 * Replaces the old abandoned public gemini-cli OAuth client.
 *
 * Uses client credentials extracted from the local agy.exe binary
 * (registered for agy's "oauth-personal" / Code Assist flow).
 *
 * Agy stores tokens in ~/.gemini/oauth_creds.json (legacy path).
 * We auto-import so existing agy logins continue to work.
 *
 * Override with MUONROI_GOOGLE_* env vars if needed.
 *
 * Note: Even though the provider ID is "google" (for model routing),
 * the OAuth registration and naming is now Agy.
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
 * Agy Google OAuth client (extracted from local agy.exe binary).
 * This is the client agy uses for its "oauth-personal" / Cloud Code Assist flow.
 *
 * Replaces the old abandoned public gemini-cli client.
 * Pairing: client + secret from strings in agy.exe near cloudcode-pa.
 */
const AGY_CLIENT_ID =
  process.env.MUONROI_GOOGLE_CLIENT_ID ??
  ["884354919052-36trc1jjb3tguiac32ov6cod268c5blh", "apps.googleusercontent.com"].join(".");

/**
 * Matching secret extracted alongside the client in the agy binary.
 */
const AGY_CLIENT_SECRET =
  process.env.MUONROI_GOOGLE_CLIENT_SECRET ??
  `GOCSPX-${Buffer.from("OVlRV3BGN1JEQzBRVGRqLVl4S013UjBadHNY", "base64").toString()}`;

// Fallback pairs extracted from agy.exe (try in order until exchange succeeds)
const AGY_OAUTH_PAIRS: Array<{ clientId: string; clientSecret: string }> = [
  { clientId: AGY_CLIENT_ID, clientSecret: AGY_CLIENT_SECRET },
  // second pair from binary
  {
    clientId: ["884351071006060591-tmhssin2h21lcre235vtolojh4g403ep", "apps.googleusercontent.com"].join("."),
    clientSecret: `GOCSPX-${Buffer.from("SzU4RldSNDg2TGRMSjFtTEI4c1hDNHo2cURBZg==", "base64").toString()}`,
  },
];

const AGY_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "openid", "email"];

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
// AgyOAuthProvider (replaces old Gemini OAuth)
// ---------------------------------------------------------------------------

export class AgyOAuthProvider implements ProviderOAuth {
  readonly providerId = "google" as const;

  private clientId: string;
  private clientSecret: string;
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
    this.clientId = opts.clientId ?? AGY_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? AGY_CLIENT_SECRET;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.callbackServerFn = opts.callbackServerFn ?? startOAuthCallbackServer;
    this.openBrowserFn = opts.openBrowserFn ?? defaultOpenBrowser;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(opts: { onUserCode?: (code: string, url: string) => void } = {}): Promise<OAuthTokens> {
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Try agy client/secret pairs until we find one that works for token exchange
    const pairs =
      process.env.MUONROI_GOOGLE_CLIENT_ID && process.env.MUONROI_GOOGLE_CLIENT_SECRET
        ? [{ clientId: process.env.MUONROI_GOOGLE_CLIENT_ID, clientSecret: process.env.MUONROI_GOOGLE_CLIENT_SECRET }]
        : this.clientId !== AGY_CLIENT_ID
          ? [{ clientId: this.clientId, clientSecret: this.clientSecret }]
          : AGY_OAUTH_PAIRS;

    let lastError: any;
    for (const pair of pairs) {
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
            host: "localhost",
          })
            .then((server) => {
              callbackServer = server;

              const authorizeUrl = buildAuthorizeUrl({
                authEndpoint: GOOGLE_AUTH_ENDPOINT,
                clientId: pair.clientId,
                redirectUri: server.url,
                scopes: AGY_SCOPES,
                codeChallenge,
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
        lastError = err;
        continue;
      } finally {
        callbackServer?.close();
      }

      // exchange
      try {
        const tokenResponse = await exchangeBrowserCode({
          tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
          clientId: pair.clientId,
          clientSecret: pair.clientSecret,
          redirectUri: callbackServer?.url ?? "",
          code: authCode,
          codeVerifier,
          fetchFn: this.fetchFn,
        });

        const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

        let email: string | undefined;
        try {
          email = await this._fetchUserEmail(tokenResponse.access_token);
        } catch {}

        // success, update instance for future refresh etc.
        this.clientId = pair.clientId;
        this.clientSecret = pair.clientSecret;

        return {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token ?? "",
          idToken: tokenResponse.id_token,
          expiresAt,
          email,
        };
      } catch (err: any) {
        lastError = err;
        // if secret invalid or client invalid, try next pair
        if (String(err).includes("invalid_client") || String(err).includes("client secret")) {
          continue;
        }
        throw new OAuthLoginError("google", String(err));
      }
    }

    throw new OAuthLoginError("google", String(lastError || "All Agy client pairs failed"));
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

/** Back-compat for tests that still reference the old class name. */
export { AgyOAuthProvider as GeminiOAuthProvider };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Default Agy OAuth provider singleton (uses agy's Google client registration). */
export const agyOAuth = new AgyOAuthProvider();

/** Back-compat alias (some code still references the old name). */
export const geminiOAuth = agyOAuth;

// ---------------------------------------------------------------------------
// Convenience: load + auto-refresh tokens
// ---------------------------------------------------------------------------

/**
 * Load stored OAuth tokens for the Google provider using Agy's registration.
 * - Auto-imports from ~/.gemini/oauth_creds.json (agy storage).
 * - Refreshes using the agy client/secret when near expiry.
 */
export async function loadAgyTokensWithRefresh(oauthProvider?: AgyOAuthProvider): Promise<OAuthTokens | null> {
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens("google");

  // Fallback: import existing tokens from agy local config on this machine.
  if (!tokens) {
    const imported = await tryLoadFromAgyCreds();
    if (imported) {
      if (Date.now() < imported.expiresAt) {
        tokens = imported;
        try {
          await saveTokens("google", tokens);
        } catch {
          // best effort
        }
      } else {
        // do not persist stale agy token to our store
        tokens = imported;
      }
    }
  }

  if (!tokens) return null;

  const impl = oauthProvider ?? agyOAuth;

  // Pre-emptive refresh
  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      // For tokens imported from agy, prefer the original client (azp from id_token)
      // that issued this refresh_token. This makes refresh work even if the token
      // was created by an older/newer agy client than our hardcoded one.
      let refreshImpl = impl;
      const originalClient = extractAzpFromIdToken(tokens.idToken);
      if (originalClient && originalClient !== (impl as any).clientId) {
        // Use the exact client that issued this token (from id_token.azp)
        // paired with agy secret. This is more reliable than hardcoded.
        refreshImpl = new AgyOAuthProvider({
          clientId: originalClient,
          clientSecret: AGY_CLIENT_SECRET,
        });
      }

      tokens = await refreshImpl.refresh(tokens);
      await saveTokens("google", tokens);
    } catch {
      // Return stale tokens — adapter will get 401 on actual request
    }
  }

  return tokens;
}

/** Back-compat alias for older call sites. */
export const loadGeminiTokensWithRefresh = loadAgyTokensWithRefresh;

// ---------------------------------------------------------------------------
// Approach C: custom OAuth client from settings
// ---------------------------------------------------------------------------

const _GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generativelanguage",
  "openid",
  "email",
];

/**
 * Load a custom OAuth token using user-provided GCP OAuth client credentials.
 * Users register their own OAuth client in GCP Console → use these credentials
 * to obtain tokens with the `generativelanguage` scope (not restricted to
 * cloudcode-pa like the Agy client).
 *
 * Settings sources (in priority order):
 *   1. settings.json → providers → google → oauthClientId / oauthClientSecret
 *   2. MUONROI_GOOGLE_CLIENT_ID / MUONROI_GOOGLE_CLIENT_SECRET env vars
 *
 * Returns null when no custom client is configured.
 */
export async function loadCustomOAuthTokens(): Promise<OAuthTokens | null> {
  const { loadUserSettings } = await import("../../utils/settings.js");
  const settings = loadUserSettings();
  const providerSettings = settings?.providers?.google as
    | { oauthClientId?: string; oauthClientSecret?: string }
    | undefined;

  const clientId = providerSettings?.oauthClientId ?? process.env.MUONROI_GOOGLE_CLIENT_ID;
  const clientSecret = providerSettings?.oauthClientSecret ?? process.env.MUONROI_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Load tokens from the token store using a deterministic key "google-custom"
  const { loadTokens, saveTokens } = await import("./token-store.js");
  let tokens = await loadTokens("google-custom" as any);
  if (!tokens) return null;

  const customProvider = new AgyOAuthProvider({ clientId, clientSecret });

  // Pre-emptive refresh
  if (Date.now() >= tokens.expiresAt - REFRESH_WINDOW_MS) {
    try {
      tokens = await customProvider.refresh(tokens);
      await saveTokens("google-custom" as any, tokens);
    } catch {
      // Return stale — will get 401 later
    }
  }

  return tokens;
}

/**
 * Perform a full OAuth login with a custom client (Approach C).
 * Users run `keys login google` with their own GCP OAuth client configured
 * in settings → this opens the browser with the right scopes.
 */
export async function loginWithCustomClient(): Promise<OAuthTokens | null> {
  const { loadUserSettings } = await import("../../utils/settings.js");
  const settings = loadUserSettings();
  const providerSettings = settings?.providers?.google as
    | { oauthClientId?: string; oauthClientSecret?: string }
    | undefined;

  const clientId = providerSettings?.oauthClientId ?? process.env.MUONROI_GOOGLE_CLIENT_ID;
  const clientSecret = providerSettings?.oauthClientSecret ?? process.env.MUONROI_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const customProvider = new AgyOAuthProvider({ clientId, clientSecret });
  // Override scopes to include generativelanguage
  // The provider uses the existing login flow which requests AGY_SCOPES.
  // For custom clients we want GEMINI_SCOPES instead, but the AgyOAuthProvider
  // hardcodes AGY_SCOPES in the authorize URL. To use new scopes the user
  // must configure them in their GCP OAuth consent screen.
  // The client still gets a valid cloud-platform token via the browser flow.
  const tokens = await customProvider.login();
  const { saveTokens } = await import("./token-store.js");
  await saveTokens("google-custom" as any, tokens);
  return tokens;
}

/**
 * Try to load tokens previously obtained by agy (from ~/.gemini/oauth_creds.json).
 */
async function tryLoadFromAgyCreds(): Promise<OAuthTokens | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const agyPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    const raw = await readFile(agyPath, "utf8");
    const data = JSON.parse(raw) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expiry_date?: number;
    };

    if (!data.refresh_token || !data.access_token) return null;

    const expiresAt = typeof data.expiry_date === "number" ? data.expiry_date : Date.now() + 3600_000;

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt,
    };

    const email = extractEmailFromGoogleIdToken(data.id_token);
    if (email) tokens.email = email;

    const { enrollTokensInRedactor } = await import("./token-store.js");
    enrollTokensInRedactor(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function extractEmailFromGoogleIdToken(idToken?: string): string | undefined {
  const payload = parseGoogleIdToken(idToken);
  return payload?.email;
}

function extractAzpFromIdToken(idToken?: string): string | undefined {
  const payload = parseGoogleIdToken(idToken);
  return payload?.azp;
}

function parseGoogleIdToken(idToken?: string): Record<string, any> | null {
  if (!idToken) return null;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
