/**
 * src/providers/auth/gcloud.ts
 *
 * Reads and refreshes tokens from Google Cloud SDK credentials
 * (~/.config/gcloud/application_default_credentials.json).
 *
 * The gcloud ADC token uses GCP's official OAuth client with cloud-platform
 * scopes, which IS accepted by generativelanguage.googleapis.com (unlike the
 * Agy OAuth token whose scope is restricted to cloudcode-pa).
 *
 * Usage:
 *   1. User runs `gcloud auth application-default login` once.
 *   2. This file reads the resulting credentials file, extracts the token,
 *      and returns it as an OAuthTokens-compatible object.
 *   3. The token auto-refreshes when expired (using the refresh_token inside
 *      the credentials file).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "./types.js";
import { OAuthRefreshError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GcloudADC {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: "authorized_user";
  /** Quota project, may be undefined. */
  quota_project_id?: string;
  /** Scopes (comma-separated), may be absent. */
  scopes?: string;
}

interface GcloudTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const GCLOUD_ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load gcloud Application Default Credentials file.
 */
async function loadADC(): Promise<GcloudADC | null> {
  try {
    const raw = await readFile(GCLOUD_ADC_PATH, "utf8");
    const creds = JSON.parse(raw) as GcloudADC;
    if (creds.type !== "authorized_user") {
      // service-account keys have a different shape; skip
      return null;
    }
    return creds;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange a gcloud refresh_token for a fresh access_token.
 * Google's OAuth token endpoint accepts gcloud ADC credentials.
 */
async function exchangeRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new OAuthRefreshError("google", `gcloud ADC refresh network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OAuthRefreshError("google", `gcloud ADC refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as GcloudTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to load a token from gcloud ADC.
 * Returns null if gcloud is not installed or no credentials exist.
 */
export async function loadGcloudToken(): Promise<OAuthTokens | null> {
  const creds = await loadADC();
  if (!creds) return null;

  return exchangeRefreshToken(creds.client_id, creds.client_secret, creds.refresh_token);
}

/**
 * Obtain auth headers from a gcloud-derived OAuthTokens.
 * Compatible with ProviderOAuth.authHeaders() signature.
 */
export function gcloudAuthHeaders(tokens: OAuthTokens): Record<string, string> {
  return { Authorization: `Bearer ${tokens.accessToken}` };
}
