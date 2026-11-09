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
import * as path from "node:path";
import { muonroiHome } from "../../utils/muonroi-home.js";
import { redactor } from "../../utils/redactor.js";
import type { OAuthTokens } from "./types.js";

/**
 * Directory holding `<provider>.json` token files.
 *
 * Two overrides, deliberately nested rather than parallel:
 *
 * - `MUONROI_AUTH_DIR` names this directory exactly and is the MORE SPECIFIC of
 *   the two, so it wins outright. Tests use it because `vi.spyOn(os, "homedir")`
 *   cannot patch a non-configurable ESM export (see
 *   `__tests__/token-store.test.ts:14-15`), and a caller that has aimed the auth
 *   dir somewhere on purpose must not have it overridden by a broader setting.
 * - `MUONROI_CLI_HOME` moves the whole muonroi home, and this now sits under it.
 *   Previously it did not: with `MUONROI_AUTH_DIR` unset, `saveTokens` joined
 *   `os.homedir()` itself and wrote next to the user's genuine OAuth tokens in
 *   the real `~/.muonroi-cli/auth/` even when the suite had pinned the home
 *   elsewhere. A specific override beating a general one is sound; silently
 *   ignoring the general one is not.
 */
function fallbackDir(): string {
  return process.env.MUONROI_AUTH_DIR ?? path.join(muonroiHome(), "auth");
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
