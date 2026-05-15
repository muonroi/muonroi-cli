/**
 * src/providers/auth/browser-flow.ts
 *
 * Generic helpers for Authorization Code + PKCE browser-redirect OAuth flows.
 * Usable for any provider that supports the standard OAuth 2.0 browser-redirect
 * grant (e.g. Google Gemini). Not for device-code flows (see device-flow.ts).
 *
 * Re-exports generatePKCE from device-flow.ts so callers need only one import.
 */

import type { FetchFn } from "./device-flow.js";

export type { PKCEPair } from "./device-flow.js";
export { generatePKCE } from "./device-flow.js";

// ---------------------------------------------------------------------------
// Build authorization URL
// ---------------------------------------------------------------------------

export interface BuildAuthorizeUrlOpts {
  authEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state?: string;
}

/**
 * Construct the authorization URL for a browser-redirect OAuth flow.
 * The caller opens this URL in the user's browser.
 */
export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOpts): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    ...(opts.state ? { state: opts.state } : {}),
  });
  return `${opts.authEndpoint}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Exchange authorization code for tokens
// ---------------------------------------------------------------------------

export interface ExchangeBrowserCodeOpts {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchFn?: FetchFn;
}

export interface BrowserTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Exchange an authorization code (obtained from the loopback callback) for
 * access/refresh tokens by POSTing to the token endpoint.
 * Throws on HTTP error.
 */
export async function exchangeBrowserCode(opts: ExchangeBrowserCodeOpts): Promise<BrowserTokenResponse> {
  const fetch = opts.fetchFn ?? globalThis.fetch;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  });

  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as BrowserTokenResponse;
}

// ---------------------------------------------------------------------------
// Refresh token exchange
// ---------------------------------------------------------------------------

export interface RefreshTokenOpts {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  fetchFn?: FetchFn;
}

/**
 * Exchange a refresh token for new tokens.
 * Throws on HTTP error (caller should handle 400/401 as permanent failure).
 */
export async function refreshBrowserTokens(opts: RefreshTokenOpts): Promise<BrowserTokenResponse> {
  const fetch = opts.fetchFn ?? globalThis.fetch;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  });

  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return (await res.json()) as BrowserTokenResponse;
}
