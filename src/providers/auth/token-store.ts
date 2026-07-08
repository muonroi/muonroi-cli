/**
 * src/providers/auth/token-store.ts
 *
 * Persistent store for provider OAuth tokens.
 * Primary:  OS keychain via keytar (same loader as keychain.ts).
 *           Account key: `oauth:<provider>`, service: "muonroi-cli".
 *           Value: JSON-serialized OAuthTokens.
 * Fallback: ~/.muonroi-cli/auth/<provider>.json, mode 0600.
 *
 * All token fields are enrolled in the redactor immediately after load.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { redactor } from "../../utils/redactor.js";
import type { OAuthTokens } from "./types.js";

const KEYCHAIN_SERVICE = "muonroi-cli";

function oauthAccount(provider: string): string {
  return `oauth:${provider}`;
}

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
// Keytar loader (mirrors keychain.ts pattern)
// ---------------------------------------------------------------------------

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    return (await import("keytar")) as KeytarLike;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist OAuth tokens for a provider.
 * Tries keychain first; falls back to filesystem (0600).
 */
// Windows Credential Manager's stub rejects credentials larger than ~2.5 KiB
// with "The stub received bad data" — OAuth blobs routinely exceed that, so
// for anything over this threshold we skip keytar and go straight to the
// file fallback (mode 0600).
const KEYCHAIN_BLOB_LIMIT_BYTES = 2000;

export async function saveTokens(provider: string, tokens: OAuthTokens): Promise<void> {
  enrollTokensInRedactor(tokens);
  const json = JSON.stringify(tokens);

  // Try keytar only for payloads small enough that Credential Manager will
  // accept them. For larger blobs, write to the 0600 file fallback directly.
  if (json.length <= KEYCHAIN_BLOB_LIMIT_BYTES) {
    const kt = await loadKeytar();
    if (kt) {
      try {
        await kt.setPassword(KEYCHAIN_SERVICE, oauthAccount(provider), json);
        return;
      } catch {
        // Keychain write failed (locked keyring, Credential Manager stub, etc.)
        // — fall through to the 0600 file fallback below. Never console.* here:
        // the TUI captures console output and OpenTUI's openConsoleOnError would
        // pop an un-dismissable overlay.
      }
    }
  }

  await mkdir(fallbackDir(), { recursive: true });
  await writeFile(fallbackPath(provider), json, { mode: 0o600, encoding: "utf8" });
}

/**
 * Load OAuth tokens for a provider.
 * Returns null if no tokens are stored.
 * Enrolled in redactor on load.
 */
export async function loadTokens(provider: string): Promise<OAuthTokens | null> {
  // Try keychain first
  const kt = await loadKeytar();
  if (kt) {
    try {
      const raw = await kt.getPassword(KEYCHAIN_SERVICE, oauthAccount(provider));
      if (raw) {
        const tokens = JSON.parse(raw) as OAuthTokens;
        enrollTokensInRedactor(tokens);
        return tokens;
      }
    } catch {
      // fall through to file
    }
  }

  // Try file fallback
  try {
    const raw = await readFile(fallbackPath(provider), "utf8");
    const tokens = JSON.parse(raw) as OAuthTokens;
    enrollTokensInRedactor(tokens);
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Delete stored OAuth tokens for a provider.
 * Attempts both keychain and file removal (either may or may not exist).
 */
export async function deleteTokens(provider: string): Promise<void> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      await kt.deletePassword(KEYCHAIN_SERVICE, oauthAccount(provider));
    } catch {
      // ignore
    }
  }

  try {
    await unlink(fallbackPath(provider));
  } catch {
    // ignore — may not exist
  }
}
