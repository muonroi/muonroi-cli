/**
 * `muonroi-cli keys` subcommand group.
 *
 * Manages provider API keys via the env-store. Keys are read by the CLI through
 * the env-store → env → settings.json priority chain in providers/keychain.ts.
 *
 * Subcommands:
 *   keys set <provider>           — interactive prompt, stores the key
 *   keys list                     — show masked keys currently stored
 *   keys delete <provider>        — remove a stored key
 *   keys export <file>            — export keys to an encrypted portable bundle
 *   keys import <file>            — import an encrypted bundle
 *   keys login <provider>         — OAuth login (openai, xai)
 *   keys logout <provider>        — OAuth logout (openai, xai)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type ChatSecretId, getChatSecret, listChatSecrets, setChatSecret } from "../chat/chat-keychain.js";
import { type McpKeyId, setMcpKey } from "../mcp/mcp-keychain.js";
import {
  deleteKeyForProvider,
  KEYCHAIN_PROVIDER_IDS,
  listStoredProviders,
  loadKeyForProvider,
  setKeyForProvider,
} from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import { decryptBundle, encryptBundle, type KeyBundleV1 } from "./keys-bundle.js";

/**
 * Providers that support OAuth login. Derived asynchronously from the OAuth
 * registry (`providers/auth/registry.ts`) so adding a new OAuth provider does
 * NOT require touching this file — append one entry in the registry.
 */
async function getOAuthProviderIds(): Promise<readonly string[]> {
  const { listOAuthProviderIds } = await import("../providers/auth/registry.js");
  return listOAuthProviderIds();
}

const MCP_KEY_IDS: readonly McpKeyId[] = ["tavily"];

function isMcpKeyId(value: string): value is McpKeyId {
  return (MCP_KEY_IDS as readonly string[]).includes(value);
}

function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function normalizeProvider(p: string): ProviderId | null {
  const lower = p.toLowerCase();
  if ((KEYCHAIN_PROVIDER_IDS as readonly string[]).includes(lower)) {
    return lower as ProviderId;
  }
  return null;
}

function _isValidProvider(p: string): p is ProviderId {
  return normalizeProvider(p) !== null;
}

async function promptHidden(question: string): Promise<string> {
  // ASCII control codes used during raw-mode capture.
  const CHAR_LF = 0x0a;
  const CHAR_CR = 0x0d;
  const CHAR_EOT = 0x04; // Ctrl+D
  const CHAR_ETX = 0x03; // Ctrl+C
  const CHAR_BACKSPACE = 0x08;
  const CHAR_DEL = 0x7f;

  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";

    const finish = (cancelled: boolean) => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write("\n");
      if (cancelled) process.exit(130);
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk[i] ?? 0;
        if (code === CHAR_LF || code === CHAR_CR || code === CHAR_EOT) {
          finish(false);
          return;
        }
        if (code === CHAR_ETX) {
          finish(true);
          return;
        }
        if (code === CHAR_BACKSPACE || code === CHAR_DEL) {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        // Skip other control bytes (arrow keys, escape sequences, etc.).
        if (code < 0x20) continue;
        value += String.fromCharCode(code);
      }
    };

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export type KeysSetOptions = Record<string, never>;

export async function runKeysSet(provider: string, _options: KeysSetOptions = {}): Promise<void> {
  const norm = normalizeProvider(provider);
  if (!norm) {
    console.error(`Unknown provider '${provider}'. Valid: ${KEYCHAIN_PROVIDER_IDS.join(", ")}`);
    process.exit(1);
  }
  const key = (await promptHidden(`Paste ${provider} API key (hidden): `)).trim();
  if (!key) {
    console.error("Aborted (empty key).");
    process.exit(1);
  }

  try {
    const ok = await setKeyForProvider(norm, key);
    if (!ok) {
      console.error("OS keychain unavailable (keytar failed to load or secret service backend unavailable).");
      console.error("Common on Linux: install the runtime library, e.g.");
      console.error("  Fedora:   sudo dnf install libsecret");
      console.error("  Ubuntu:   sudo apt-get install libsecret-1-0");
      console.error("Then ensure you have an active graphical session or keyring daemon (gnome-keyring).");
      console.error("Falling back: set environment variable instead (still works at runtime):");
      console.error(`  export ${provider.toUpperCase()}_API_KEY='<your key>'`);
      process.exit(2);
    }
    console.log(`Stored ${provider} key in OS keychain.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

export async function runMcpKeysSet(id: string, _options: KeysSetOptions = {}): Promise<void> {
  if (!isMcpKeyId(id)) {
    console.error(`Unknown MCP key '${id}'. Valid: ${MCP_KEY_IDS.join(", ")}`);
    process.exit(1);
  }
  const key = (await promptHidden(`Paste ${id} API key (hidden): `)).trim();
  if (!key) {
    console.error("Aborted (empty key).");
    process.exit(1);
  }

  try {
    const ok = await setMcpKey(id, key);
    if (!ok) {
      console.error("OS keychain unavailable (keytar failed to load or secret service backend unavailable).");
      console.error("Common on Linux: install the runtime library, e.g.");
      console.error("  Fedora:   sudo dnf install libsecret");
      console.error("  Ubuntu:   sudo apt-get install libsecret-1-0");
      console.error(`Falling back: export ${id.toUpperCase()}_API_KEY='<your key>' (still picked up at runtime).`);
      process.exit(2);
    }
    console.log(`Stored MCP key '${id}' in OS keychain.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

export async function runKeysList(): Promise<void> {
  const stored = await listStoredProviders();
  const chatStored = await listChatSecrets();

  // Load OAuth tokens for supported providers
  const { loadTokens } = await import("../providers/auth/token-store.js");
  const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
  const oauthRows: Array<{ provider: string; display: string; email?: string; expiresAt: number }> = [];
  const oauthIds = await getOAuthProviderIds();
  for (const p of oauthIds) {
    try {
      const tokens = await loadTokens(p);
      if (tokens && Date.now() < tokens.expiresAt) {
        const cfg = await getOAuthProviderConfig(p as any);
        const display = cfg?.displayName ?? p;
        oauthRows.push({ provider: p, display, email: tokens.email, expiresAt: tokens.expiresAt });
      }
    } catch {
      // ignore
    }
  }

  const hasAnything = stored.length > 0 || chatStored.length > 0 || oauthRows.length > 0;
  if (!hasAnything) {
    console.log("No keys stored in OS keychain.");
    console.log("Run 'muonroi-cli keys set <provider>' to add some.");
    console.log("Run 'muonroi-cli keys login openai' to log in with your OpenAI subscription.");
    console.log("Run 'muonroi-cli keys login xai' to log in with your SuperGrok / X Premium+ subscription.");
    return;
  }

  // OAuth section (shown before API keys so subscription auth is prominent)
  if (oauthRows.length > 0) {
    console.log("OAuth (subscription)");
    console.log("Provider     Account                    Expires");
    console.log("-----------  -------------------------  -------------------------");
    for (const row of oauthRows) {
      const account = row.email ?? "(no email)";
      const expiry = new Date(row.expiresAt).toLocaleString();
      const expired = Date.now() > row.expiresAt ? " [EXPIRED]" : "";
      console.log(`${row.display.padEnd(12)} ${account.padEnd(26)} ${expiry}${expired}`);
    }
    console.log("");
  }

  if (stored.length > 0) {
    console.log("API Keys");
    console.log("Provider     Key");
    console.log("-----------  --------");
    const { loadKeyForProvider } = await import("../providers/keychain.js");
    for (const p of stored) {
      try {
        const k = await loadKeyForProvider(p);
        console.log(`${p.padEnd(12)} ${maskKey(k)}`);
      } catch {
        console.log(`${p.padEnd(12)} <unreadable>`);
      }
    }
  }

  if (chatStored.length > 0) {
    console.log("");
    console.log("Chat Secret              Value");
    console.log("------------------------  --------");
    for (const id of chatStored) {
      try {
        const v = await getChatSecret(id);
        if (v) {
          // For tokens (longer, sensitive), mask middle; for IDs, show in full
          const displayValue = id.includes("token") ? maskKey(v) : v;
          console.log(`${id.padEnd(24)} ${displayValue}`);
        }
      } catch {
        console.log(`${id.padEnd(24)} <unreadable>`);
      }
    }
  }
}

export async function runKeysDelete(provider: string): Promise<void> {
  const norm = normalizeProvider(provider);
  if (!norm) {
    console.error(`Unknown provider '${provider}'. Valid: ${KEYCHAIN_PROVIDER_IDS.join(", ")}`);
    process.exit(1);
  }
  const ok = await deleteKeyForProvider(norm);
  console.log(ok ? `Deleted ${provider} key from keychain.` : `No ${provider} key was stored.`);
}

export async function runKeysExport(filePath: string): Promise<void> {
  const providers: Record<string, string> = {};
  for (const p of KEYCHAIN_PROVIDER_IDS) {
    try {
      const k = await loadKeyForProvider(p);
      if (k && k.length >= 20) providers[p] = k;
    } catch {
      /* no key for this provider — skip */
    }
  }
  const found = Object.keys(providers);
  if (found.length === 0) {
    console.error("No provider keys found to export.");
    process.exit(1);
  }

  console.log(`Exporting ${found.length} key(s): ${found.join(", ")}`);
  const pass1 = await promptHidden("Choose a passphrase (min 8 chars, hidden): ");
  if (pass1.length < 8) {
    console.error("Passphrase too short (min 8 chars). Aborted.");
    process.exit(1);
  }
  const pass2 = await promptHidden("Confirm passphrase: ");
  if (pass1 !== pass2) {
    console.error("Passphrases do not match. Aborted.");
    process.exit(1);
  }

  const bundle = encryptBundle({ providers }, pass1);
  const abs = path.resolve(filePath);
  await fs.writeFile(abs, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  console.log(`Wrote encrypted bundle → ${abs}`);
  console.log("Move this file to the target device, then run: muonroi-cli keys import <file>");
}

export async function runKeysImport(filePath: string): Promise<void> {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (e) {
    console.error(`Cannot read bundle file '${abs}': ${(e as Error).message}`);
    process.exit(1);
  }
  let bundle: KeyBundleV1;
  try {
    bundle = JSON.parse(raw) as KeyBundleV1;
  } catch (e) {
    console.error(`Bundle file is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  const pass = await promptHidden("Bundle passphrase (hidden): ");
  let payload: { providers: Record<string, string> };
  try {
    payload = decryptBundle(bundle, pass);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const entries = Object.entries(payload.providers);
  if (entries.length === 0) {
    console.error("Bundle decrypted but contains no provider keys.");
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;
  for (const [provider, key] of entries) {
    const norm = normalizeProvider(provider);
    if (!norm) {
      console.warn(`Skipping unknown provider '${provider}' in bundle.`);
      skipped++;
      continue;
    }
    try {
      const ok = await setKeyForProvider(norm, key);
      if (ok) {
        imported++;
        console.log(`✓ ${provider} → keychain (${maskKey(key)})`);
      } else {
        console.warn(`! ${provider} — keychain unavailable, key not stored`);
        skipped++;
      }
    } catch (e) {
      console.warn(`! ${provider} — ${(e as Error).message}`);
      skipped++;
    }
  }
  console.log(`\nImported ${imported} key(s); ${skipped} skipped.`);
}

export async function runChatKeySet(id: ChatSecretId, value: string): Promise<void> {
  if (!value || value.length < 8) {
    console.error(`Value for chat secret '${id}' is too short (< 8 chars).`);
    process.exit(1);
  }

  try {
    const ok = await setChatSecret(id, value);
    if (!ok) {
      console.error("OS keychain unavailable (keytar failed to load or secret service backend unavailable).");
      console.error(
        "Common on Linux: install the runtime library, e.g. sudo dnf install libsecret (Fedora) or apt libsecret-1-0 (Ubuntu).",
      );
      console.error(
        `Falling back: export ${id.includes("token") ? "MUONROI_" : "MUONROI_"}${id.replace("-", "_").toUpperCase()}='<your value>'`,
      );
      process.exit(2);
    }
    console.log(`Stored chat secret '${id}' in OS keychain.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// OAuth login / logout
// ---------------------------------------------------------------------------

/**
 * `muonroi-cli keys login <provider>`
 *
 * Runs the OAuth flow for the given provider, dispatching through the OAuth
 * registry (`providers/auth/registry.ts`). Adding a new OAuth provider is
 * registry-only — no edits to this function.
 *
 * Persists tokens after successful login.
 */
export async function runKeysLogin(provider: string): Promise<void> {
  const oauthIds = await getOAuthProviderIds();
  const norm = provider;
  if (!oauthIds.includes(norm)) {
    const supported = oauthIds.join(", ");
    console.error(`OAuth login not supported for '${provider}'. Supported: ${supported}`);
    process.exit(1);
  }

  const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
  const { saveTokens } = await import("../providers/auth/token-store.js");

  const cfg = await getOAuthProviderConfig(norm as ProviderId);
  if (!cfg) {
    console.error(`OAuth provider '${provider}' is registered but failed to load.`);
    process.exit(1);
  }

  const name = cfg.displayName;

  console.log(`Logging in to ${name} via OAuth...`);
  console.log("A browser window will open. Complete the sign-in to continue.");

  const tokens = await cfg.provider.login({
    onUserCode(codeOrUrl, url) {
      // OAuth providers may call onUserCode with either:
      //   - (authorizeUrl) — browser-redirect / loopback callback flow
      //   - (userCode, verificationUrl) — device-code flow
      // Print whatever is available without branching on provider id.
      console.log("\n  If the browser does not open, paste this URL manually:");
      console.log(`  ${url ?? codeOrUrl}`);
      if (url && codeOrUrl !== url) {
        console.log(`  User code: ${codeOrUrl}`);
      }
      console.log("\n  Waiting for authorization...");
      if (norm === "xai") {
        console.log("  (If the xAI page shows a code instead of redirecting, paste it when the terminal prompts.)");
      }
    },
  });

  await saveTokens(norm, tokens);

  // One auth mode per provider (OAuth XOR API key): logging in via OAuth clears
  // any stored API key for this provider so a stale key can never shadow OAuth.
  try {
    const { clearEnvVar } = await import("../providers/env-store.js");
    const { ENV_BY_PROVIDER } = await import("../providers/keychain.js");
    clearEnvVar(ENV_BY_PROVIDER[norm as ProviderId]);
  } catch (err) {
    console.error(
      `[keys] failed to clear API key after OAuth login for ${norm}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const emailDisplay = tokens.email ? ` (${tokens.email})` : "";
  const expiry = new Date(tokens.expiresAt).toLocaleString();
  console.log(`\nLogged in to ${name}${emailDisplay}. Token expires: ${expiry}`);
  console.log("Run 'muonroi-cli keys list' to verify.");
}

/**
 * `muonroi-cli keys logout <provider>`
 *
 * Revokes the token at the issuer and deletes stored tokens. Dispatches
 * through the OAuth registry — no provider branching.
 */
export async function runKeysLogout(provider: string): Promise<void> {
  const oauthIds = await getOAuthProviderIds();
  const norm = provider;
  if (!oauthIds.includes(norm)) {
    const supported = oauthIds.join(", ");
    console.error(`OAuth logout not supported for '${provider}'. Supported: ${supported}`);
    process.exit(1);
  }

  const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
  const { loadTokens, deleteTokens } = await import("../providers/auth/token-store.js");

  const tokens = await loadTokens(norm);
  if (!tokens) {
    console.log(`No OAuth tokens stored for '${provider}'.`);
    return;
  }

  const cfg = await getOAuthProviderConfig(norm as ProviderId);
  if (cfg) {
    await cfg.provider.revoke(tokens); // best-effort
  }

  await deleteTokens(norm);
  const name = cfg?.displayName ?? provider;
  console.log(`Logged out of ${name}. OAuth tokens revoked and deleted.`);
}
