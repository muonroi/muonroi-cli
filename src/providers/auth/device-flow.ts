/**
 * src/providers/auth/device-flow.ts
 *
 * Generic Device Authorization Grant helpers with PKCE support.
 * All HTTP calls go through an injectable `fetchFn` — never hits live
 * auth.openai.com in tests.
 *
 * Flow:
 *   1. generatePKCE()         — produce code_verifier + code_challenge
 *   2. requestDeviceCode()    — POST to usercode endpoint
 *   3. pollDeviceAuthorization() — poll until approved / denied / timed out
 *   4. exchangeCodeForTokens() — exchange authorization_code + verifier → tokens
 */

import { createHash, randomBytes } from "node:crypto";
import type { DeviceCodeResponse, TokenExchangeResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Fetch abstraction
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generate a PKCE code_verifier (43-128 chars, URL-safe) and the
 * corresponding S256 code_challenge.
 */
export function generatePKCE(): PKCEPair {
  // 32 random bytes → 43 base64url chars (within PKCE 43-128 range)
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Step 1: request device code
// ---------------------------------------------------------------------------

export interface RequestDeviceCodeOpts {
  issuer: string;
  clientId: string;
  scope?: string;
  codeChallenge: string;
  fetchFn?: FetchFn;
}

/**
 * POST to the device-code endpoint and return the server response.
 * Throws on HTTP errors.
 */
export async function requestDeviceCode(opts: RequestDeviceCodeOpts): Promise<DeviceCodeResponse> {
  const fetch = opts.fetchFn ?? globalThis.fetch;
  const url = `${opts.issuer}/api/accounts/deviceauth/usercode`;

  const body = JSON.stringify({
    client_id: opts.clientId,
    scope: opts.scope ?? "openid profile email offline_access",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Device code request failed (${res.status}): ${text}`);
  }

  // The actual OpenAI API returns a non-standard response shape:
  //   { device_auth_id, user_code, expires_at (ISO string), interval (string) }
  // with no `verification_uri` field at all. Transform it to DeviceCodeResponse.
  const raw = (await res.json()) as Record<string, unknown>;
  const expiresAt = raw.expires_at ? new Date(raw.expires_at as string).getTime() : Date.now() + 300_000;

  return {
    device_code: String(raw.device_auth_id ?? raw.device_code ?? ""),
    user_code: String(raw.user_code ?? ""),
    verification_uri: (raw.verification_uri as string | undefined) ?? `${opts.issuer}/device`,
    expires_in: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
    interval: raw.interval != null ? Number(raw.interval) : 5,
  };
}

// ---------------------------------------------------------------------------
// Step 2: poll token endpoint until approved (RFC 8628 device code grant)
// ---------------------------------------------------------------------------

export interface PollOpts {
  issuer: string;
  clientId: string;
  deviceCode: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

/**
 * Poll the OAuth token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
 * until the user authorizes or the request times out (RFC 8628).
 *
 * Returns tokens directly on success. Handles:
 * - authorization_pending → keep polling
 * - slow_down → increase interval
 * - access_denied → throws
 * - expired_token → throws
 */
export async function pollDeviceAuthorization(opts: PollOpts): Promise<TokenExchangeResponse> {
  const fetch = opts.fetchFn ?? globalThis.fetch;
  let pollInterval = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);

  const url = `${opts.issuer}/oauth/token`;
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: opts.deviceCode,
    client_id: opts.clientId,
  };

  while (Date.now() < deadline) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return (await res.json()) as TokenExchangeResponse;
    }

    // RFC 8628 error responses are JSON with an "error" field
    let errorCode: string | undefined;
    try {
      const errBody = (await res.json()) as { error?: string };
      errorCode = errBody.error;
    } catch {
      // non-JSON response — treat as unexpected
    }

    switch (errorCode) {
      case "authorization_pending":
        // user hasn't approved yet — keep polling
        break;
      case "slow_down":
        // server asks us to back off
        pollInterval += 5_000;
        break;
      case "access_denied":
        throw new Error("Device authorization denied");
      case "expired_token":
        throw new Error("Device authorization expired");
      default:
        // Unknown or missing error field — fall through to keep polling
        break;
    }

    await sleep(pollInterval);
  }

  throw new Error("Device authorization timed out");
}

// ---------------------------------------------------------------------------
// Step 3: exchange authorization_code for tokens
// ---------------------------------------------------------------------------

export interface ExchangeCodeOpts {
  issuer: string;
  clientId: string;
  authorizationCode: string;
  codeVerifier: string;
  fetchFn?: FetchFn;
}

/**
 * POST to the token endpoint with code + verifier to obtain access/refresh tokens.
 */
export async function exchangeCodeForTokens(opts: ExchangeCodeOpts): Promise<TokenExchangeResponse> {
  const fetch = opts.fetchFn ?? globalThis.fetch;
  const url = `${opts.issuer}/oauth/token`;

  const body = JSON.stringify({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.authorizationCode,
    code_verifier: opts.codeVerifier,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenExchangeResponse;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
