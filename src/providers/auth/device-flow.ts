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

  return (await res.json()) as DeviceCodeResponse;
}

// ---------------------------------------------------------------------------
// Step 2: poll until approved
// ---------------------------------------------------------------------------

export interface PollOpts {
  issuer: string;
  deviceCode: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

export interface PollResult {
  authorization_code: string;
}

/**
 * Poll the device-auth status endpoint until:
 * - status = "complete"  → returns { authorization_code }
 * - status = "denied"   → throws OAuthLoginError
 * - timeout exceeded    → throws Error
 */
export async function pollDeviceAuthorization(opts: PollOpts): Promise<PollResult> {
  const fetch = opts.fetchFn ?? globalThis.fetch;
  const pollInterval = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);

  const url = `${opts.issuer}/api/accounts/deviceauth/usercode?device_code=${encodeURIComponent(opts.deviceCode)}`;

  while (Date.now() < deadline) {
    const res = await fetch(url, { method: "GET" });

    if (res.ok) {
      const data = (await res.json()) as { status?: string; authorization_code?: string };
      if (data.status === "complete" && data.authorization_code) {
        return { authorization_code: data.authorization_code };
      }
      if (data.status === "denied" || data.status === "expired") {
        throw new Error(`Device authorization ${data.status}`);
      }
      // status === "pending" — keep polling
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
