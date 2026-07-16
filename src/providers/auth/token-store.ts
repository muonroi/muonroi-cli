/**
 * src/providers/auth/token-store.ts
 *
 * Persistent store for provider OAuth tokens.
 * Storage: ~/.muonroi-cli/auth/<provider>.json, mode 0600 (JSON-serialized
 *          OAuthTokens). The OS keychain (keytar) has been removed.
 *
 * All token fields are enrolled in the redactor immediately after load.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { redactor } from "../../utils/redactor.js";
import type { OAuthTokens } from "./types.js";

/**
 * Override for tests — set process.env.MUONROI_AUTH_DIR to point at a temp dir.
 */
function fallbackDir(): string {
  return process.env.MUONROI_AUTH_DIR ?? path.join(os.homedir(), ".muonroi-cli", "auth");
}

function fallbackPath(provider: string): string {
  return path.join(fallbackDir(), `${provider}.json`);
}

// ---------------------------------------------------------------------------
// Redactor helper
// ---------------------------------------------------------------------------

/**
 * Enroll all token secrets so they are scrubbed from logs.
 */
export function enrollTokensInRedactor(tokens: OAuthTokens): void {
  redactor.enrollSecret(tokens.accessToken);
  redactor.enrollSecret(tokens.refreshToken);
  if (tokens.idToken) redactor.enrollSecret(tokens.idToken);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist OAuth tokens for a provider to ~/.muonroi-cli/auth/<provider>.json
 * (mode 0600).
 */
export async function saveTokens(provider: string, tokens: OAuthTokens): Promise<void> {
  enrollTokensInRedactor(tokens);
  const json = JSON.stringify(tokens);
  await mkdir(fallbackDir(), { recursive: true });
  await writeFile(fallbackPath(provider), json, { mode: 0o600, encoding: "utf8" });
}

/**
 * Load OAuth tokens for a provider from the 0600 file store.
 * Returns null if no tokens are stored. Enrolled in redactor on load.
 */
export async function loadTokens(provider: string): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(fallbackPath(provider), "utf8");
    const tokens = JSON.parse(raw) as OAuthTokens;
    enrollTokensInRedactor(tokens);
    return tokens;
  } catch {
    // Missing/unreadable file → no tokens stored.
    return null;
  }
}

/**
 * Delete stored OAuth tokens for a provider (removes the 0600 file).
 */
export async function deleteTokens(provider: string): Promise<void> {
  try {
    await unlink(fallbackPath(provider));
  } catch {
    // ignore — may not exist
  }
}
