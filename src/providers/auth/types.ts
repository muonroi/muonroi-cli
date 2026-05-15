/**
 * src/providers/auth/types.ts
 *
 * Provider OAuth interfaces and token shapes.
 * Designed to be extensible for Anthropic / Google OAuth in the future.
 */

import type { ProviderId } from "../types.js";

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  /** JWT access token for Bearer auth. */
  accessToken: string;
  /** Opaque refresh token for obtaining new access tokens. */
  refreshToken: string;
  /** Optional OpenID id_token. */
  idToken?: string;
  /** Provider-specific account identifier (e.g. OpenAI account_id). */
  accountId?: string;
  /** Absolute epoch-ms when the access token expires. */
  expiresAt: number;
  /** User email, fetched from userinfo endpoint if available. */
  email?: string;
}

// ---------------------------------------------------------------------------
// Provider OAuth interface
// ---------------------------------------------------------------------------

export interface ProviderOAuth {
  readonly providerId: ProviderId;

  /**
   * Run the Device-Code + PKCE login flow.
   * Calls onUserCode with the human-readable code + verification URL so the
   * caller can display them to the user before polling.
   */
  login(opts: { onUserCode?: (code: string, url: string) => void }): Promise<OAuthTokens>;

  /**
   * Exchange a refresh token for new tokens.
   * Throws OAuthRefreshError on permanent failure (invalid_grant).
   */
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;

  /**
   * Revoke the refresh token at the issuer.
   * Best-effort — callers should delete local tokens regardless.
   */
  revoke(tokens: OAuthTokens): Promise<void>;

  /**
   * Return the HTTP headers required to authenticate a provider request.
   * e.g. { Authorization: "Bearer ey...", "ChatGPT-Account-ID": "acc_..." }
   */
  authHeaders(tokens: OAuthTokens): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuthRefreshError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly cause?: string,
  ) {
    super(`OAuth refresh failed for '${provider}'${cause ? `: ${cause}` : ""}`);
    this.name = "OAuthRefreshError";
  }
}

export class OAuthLoginError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly cause?: string,
  ) {
    super(`OAuth login failed for '${provider}'${cause ? `: ${cause}` : ""}`);
    this.name = "OAuthLoginError";
  }
}

// ---------------------------------------------------------------------------
// Device flow types (used by device-flow.ts)
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in?: number;
  interval?: number;
}

export interface TokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
  token_type?: string;
}

export interface UserInfo {
  email?: string;
  name?: string;
  sub?: string;
}
