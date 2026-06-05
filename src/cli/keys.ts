/**
 * `muonroi-cli keys` subcommand group.
 *
 * Manages provider API keys via the OS keychain (Windows Credential Manager,
 * macOS Keychain, libsecret on Linux). Keys are read by the CLI through the
 * keychain → env → settings.json priority chain in providers/keychain.ts.
 *
 * Subcommands:
 *   keys set <provider>           — interactive prompt, stores in keychain
 *   keys list                     — show masked keys currently stored
 *   keys delete <provider>        — remove a stored key
 *   keys import-bw [providers]    — pull from Bitwarden vault, store in keychain
 *   keys cleanup-settings         — strip plaintext keys from user-settings.json
 *   keys login <provider>         — OAuth login (openai, google)
 *   keys logout <provider>        — OAuth logout (openai, google)
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
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

const CHAT_SECRET_IDS: readonly ChatSecretId[] = ["discord-token", "discord-guild-id", "slack-token", "slack-team-id"];

function isChatSecretId(value: string): value is ChatSecretId {
  return (CHAT_SECRET_IDS as readonly string[]).includes(value);
}

const SETTINGS_PATH = path.join(os.homedir(), ".muonroi-cli", "user-settings.json");

function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function isValidProvider(p: string): p is ProviderId {
  return (KEYCHAIN_PROVIDER_IDS as string[]).includes(p);
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

export interface KeysSetOptions {
  bw?: boolean;
  itemPrefix?: string;
}

export async function runKeysSet(provider: string, options: KeysSetOptions = {}): Promise<void> {
  if (!isValidProvider(provider)) {
    console.error(`Unknown provider '${provider}'. Valid: ${KEYCHAIN_PROVIDER_IDS.join(", ")}`);
    process.exit(1);
  }
  const key = (await promptHidden(`Paste ${provider} API key (hidden): `)).trim();
  if (!key) {
    console.error("Aborted (empty key).");
    process.exit(1);
  }

  if (options.bw) {
    const { writeBwSecureNote } = await import("./bw-vault.js");
    const itemName = `${options.itemPrefix ?? "muonroi-cli/"}${provider}`;
    const res = await writeBwSecureNote(itemName, key);
    if (!res.ok) {
      console.error(`Bitwarden write failed: ${res.error}`);
      process.exit(2);
    }
    console.log(`Bitwarden vault: ${res.action} '${itemName}'.`);
  }

  try {
    const ok = await setKeyForProvider(provider, key);
    if (!ok) {
      console.error("OS keychain unavailable on this platform (keytar failed to load).");
      console.error("Falling back: set environment variable instead, e.g.");
      console.error(`  export ${provider.toUpperCase()}_API_KEY='<your key>'`);
      process.exit(2);
    }
    console.log(`Stored ${provider} key in OS keychain.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

export async function runMcpKeysSet(id: string, options: KeysSetOptions = {}): Promise<void> {
  if (!isMcpKeyId(id)) {
    console.error(`Unknown MCP key '${id}'. Valid: ${MCP_KEY_IDS.join(", ")}`);
    process.exit(1);
  }
  const key = (await promptHidden(`Paste ${id} API key (hidden): `)).trim();
  if (!key) {
    console.error("Aborted (empty key).");
    process.exit(1);
  }

  if (options.bw) {
    const { writeBwSecureNote } = await import("./bw-vault.js");
    const itemName = `${options.itemPrefix ?? "muonroi-cli/"}${id}`;
    const res = await writeBwSecureNote(itemName, key);
    if (!res.ok) {
      console.error(`Bitwarden write failed: ${res.error}`);
      process.exit(2);
    }
    console.log(`Bitwarden vault: ${res.action} '${itemName}'.`);
  }

  try {
    const ok = await setMcpKey(id, key);
    if (!ok) {
      console.error("OS keychain unavailable on this platform (keytar failed to load).");
      console.error(`Falling back: set environment variable: export ${id.toUpperCase()}_API_KEY='<your key>'`);
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
  const oauthRows: Array<{ provider: string; email?: string; expiresAt: number }> = [];
  const oauthIds = await getOAuthProviderIds();
  for (const p of oauthIds) {
    try {
      const tokens = await loadTokens(p);
      if (tokens) {
        oauthRows.push({ provider: p, email: tokens.email, expiresAt: tokens.expiresAt });
      }
    } catch {
      // ignore
    }
  }

  const hasAnything = stored.length > 0 || chatStored.length > 0 || oauthRows.length > 0;
  if (!hasAnything) {
    console.log("No keys stored in OS keychain.");
    console.log("Run 'muonroi-cli keys set <provider>' or 'muonroi-cli keys import-bw' to add some.");
    console.log("Run 'muonroi-cli keys login openai' to log in with your OpenAI subscription.");
    console.log("Run 'muonroi-cli keys login google' to log in with your Google account.");
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
      console.log(`${row.provider.padEnd(12)} ${account.padEnd(26)} ${expiry}${expired}`);
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
  if (!isValidProvider(provider)) {
    console.error(`Unknown provider '${provider}'. Valid: ${KEYCHAIN_PROVIDER_IDS.join(", ")}`);
    process.exit(1);
  }
  const ok = await deleteKeyForProvider(provider);
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
    if (!isValidProvider(provider)) {
      console.warn(`Skipping unknown provider '${provider}' in bundle.`);
      skipped++;
      continue;
    }
    try {
      const ok = await setKeyForProvider(provider, key);
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

interface BwImportOptions {
  providers?: string[];
  itemPrefix?: string;
}

export async function runKeysImportBw(opts: BwImportOptions = {}): Promise<void> {
  const which = spawnSync("bw", ["--version"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.error("Bitwarden CLI ('bw') not found in PATH.");
    console.error("Install: https://bitwarden.com/help/cli/");
    process.exit(2);
  }

  const session = process.env.BW_SESSION;
  if (!session) {
    console.error("BW_SESSION not set. Run:");
    console.error("  export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const status = spawnSync("bw", ["status", "--session", session], { encoding: "utf8" });
  if (status.status !== 0) {
    console.error(`bw status failed: ${status.stderr || status.stdout}`);
    process.exit(2);
  }
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = {};
  }
  if (parsed.status !== "unlocked") {
    console.error(`Bitwarden vault is not unlocked (status: ${parsed.status ?? "unknown"}).`);
    console.error("Run: export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const requested = opts.providers && opts.providers.length > 0 ? opts.providers : KEYCHAIN_PROVIDER_IDS.slice();
  const prefix = opts.itemPrefix ?? "muonroi-cli/";

  let imported = 0;
  let skipped = 0;
  for (const provider of requested) {
    if (!isValidProvider(provider)) {
      console.warn(`Skip unknown provider: ${provider}`);
      skipped++;
      continue;
    }
    const itemName = `${prefix}${provider}`;
    const got = spawnSync("bw", ["get", "notes", itemName, "--session", session], { encoding: "utf8" });
    if (got.status !== 0) {
      // bw prints "Not found." on stderr when the item is missing — treat as skip.
      skipped++;
      continue;
    }
    const key = got.stdout.trim();
    if (!key || key.length < 20) {
      console.warn(`Skip ${provider}: vault item '${itemName}' empty or too short.`);
      skipped++;
      continue;
    }
    try {
      const ok = await setKeyForProvider(provider, key);
      if (!ok) {
        console.error("OS keychain unavailable. Aborting import.");
        process.exit(2);
      }
      console.log(`Imported ${provider} → keychain.`);
      imported++;
    } catch (e) {
      console.warn(`Failed ${provider}: ${(e as Error).message}`);
      skipped++;
    }
  }
  console.log(`\nDone. Imported: ${imported}, skipped: ${skipped}.`);
  if (imported > 0) {
    console.log("Run 'muonroi-cli keys cleanup-settings' to strip any plaintext keys from settings.json.");
  }
}

interface McpBwImportOptions {
  keys?: string[];
  itemPrefix?: string;
}

/**
 * Import MCP secrets (e.g. Tavily) from a Bitwarden vault into the OS
 * keychain via mcp-keychain. Vault items are expected at `<prefix><id>` —
 * default prefix `muonroi-cli/`. The key value is read from the item's
 * notes field, mirroring the provider import-bw flow.
 */
export async function runMcpImportBw(opts: McpBwImportOptions = {}): Promise<void> {
  const which = spawnSync("bw", ["--version"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.error("Bitwarden CLI ('bw') not found in PATH.");
    console.error("Install: https://bitwarden.com/help/cli/");
    process.exit(2);
  }

  const session = process.env.BW_SESSION;
  if (!session) {
    console.error("BW_SESSION not set. Run:");
    console.error("  export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const status = spawnSync("bw", ["status", "--session", session], { encoding: "utf8" });
  if (status.status !== 0) {
    console.error(`bw status failed: ${status.stderr || status.stdout}`);
    process.exit(2);
  }
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = {};
  }
  if (parsed.status !== "unlocked") {
    console.error(`Bitwarden vault is not unlocked (status: ${parsed.status ?? "unknown"}).`);
    console.error("Run: export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const requested = opts.keys && opts.keys.length > 0 ? opts.keys : MCP_KEY_IDS.slice();
  const prefix = opts.itemPrefix ?? "muonroi-cli/";

  let imported = 0;
  let skipped = 0;
  for (const id of requested) {
    if (!isMcpKeyId(id)) {
      console.warn(`Skip unknown MCP key: ${id}`);
      skipped++;
      continue;
    }
    const itemName = `${prefix}${id}`;
    const got = spawnSync("bw", ["get", "notes", itemName, "--session", session], { encoding: "utf8" });
    if (got.status !== 0) {
      skipped++;
      continue;
    }
    const key = got.stdout.trim();
    if (!key || key.length < 16) {
      console.warn(`Skip ${id}: vault item '${itemName}' empty or too short.`);
      skipped++;
      continue;
    }
    try {
      const ok = await setMcpKey(id, key);
      if (!ok) {
        console.error("OS keychain unavailable. Aborting import.");
        process.exit(2);
      }
      console.log(`Imported MCP key '${id}' → keychain.`);
      imported++;
    } catch (e) {
      console.warn(`Failed ${id}: ${(e as Error).message}`);
      skipped++;
    }
  }
  console.log(`\nDone. Imported: ${imported}, skipped: ${skipped}.`);
}

export async function runChatKeySet(id: ChatSecretId, value: string): Promise<void> {
  if (!value || value.length < 8) {
    console.error(`Value for chat secret '${id}' is too short (< 8 chars).`);
    process.exit(1);
  }

  try {
    const ok = await setChatSecret(id, value);
    if (!ok) {
      console.error("OS keychain unavailable on this platform (keytar failed to load).");
      console.error(
        `Falling back: set environment variable: export ${id.includes("token") ? "MUONROI_" : "MUONROI_"}${id.replace("-", "_").toUpperCase()}='<your value>'`,
      );
      process.exit(2);
    }
    console.log(`Stored chat secret '${id}' in OS keychain.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

interface ChatBwImportOptions {
  ids?: ChatSecretId[];
  itemPrefix?: string;
}

/**
 * Import chat secrets (discord-token, discord-guild-id, slack-token, slack-team-id)
 * from a Bitwarden vault into the OS keychain. Vault items are expected at
 * `<prefix><id>` — default prefix `muonroi-cli/chat-`. The value is read from
 * the item's notes field, mirroring the provider/MCP import-bw flow.
 */
export async function runChatImportBw(opts: ChatBwImportOptions = {}): Promise<void> {
  const which = spawnSync("bw", ["--version"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.error("Bitwarden CLI ('bw') not found in PATH.");
    console.error("Install: https://bitwarden.com/help/cli/");
    process.exit(2);
  }

  const session = process.env.BW_SESSION;
  if (!session) {
    console.error("BW_SESSION not set. Run:");
    console.error("  export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const status = spawnSync("bw", ["status", "--session", session], { encoding: "utf8" });
  if (status.status !== 0) {
    console.error(`bw status failed: ${status.stderr || status.stdout}`);
    process.exit(2);
  }
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = {};
  }
  if (parsed.status !== "unlocked") {
    console.error(`Bitwarden vault is not unlocked (status: ${parsed.status ?? "unknown"}).`);
    console.error("Run: export BW_SESSION=$(bw unlock --raw)");
    process.exit(2);
  }

  const requested = opts.ids && opts.ids.length > 0 ? opts.ids : CHAT_SECRET_IDS.slice();
  const prefix = opts.itemPrefix ?? "muonroi-cli/chat-";

  let imported = 0;
  let skipped = 0;
  for (const id of requested) {
    if (!isChatSecretId(id)) {
      console.warn(`Skip unknown chat secret: ${id}`);
      skipped++;
      continue;
    }
    const itemName = `${prefix}${id}`;
    const got = spawnSync("bw", ["get", "notes", itemName, "--session", session], { encoding: "utf8" });
    if (got.status !== 0) {
      // bw prints "Not found." on stderr when the item is missing — treat as skip.
      skipped++;
      continue;
    }
    const value = got.stdout.trim();
    if (!value || value.length < 8) {
      console.warn(`Skip ${id}: vault item '${itemName}' empty or too short.`);
      skipped++;
      continue;
    }
    try {
      const ok = await setChatSecret(id, value);
      if (!ok) {
        console.error("OS keychain unavailable. Aborting import.");
        process.exit(2);
      }
      console.log(`Imported chat secret '${id}' → keychain.`);
      imported++;
    } catch (e) {
      console.warn(`Failed ${id}: ${(e as Error).message}`);
      skipped++;
    }
  }
  console.log(`\nDone. Imported: ${imported}, skipped: ${skipped}.`);
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
  if (!oauthIds.includes(provider)) {
    console.error(`OAuth login not supported for '${provider}'. Supported: ${oauthIds.join(", ")}`);
    process.exit(1);
  }

  const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
  const { saveTokens } = await import("../providers/auth/token-store.js");

  const cfg = await getOAuthProviderConfig(provider as ProviderId);
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
    },
  });

  await saveTokens(provider, tokens);

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
  if (!oauthIds.includes(provider)) {
    console.error(`OAuth logout not supported for '${provider}'. Supported: ${oauthIds.join(", ")}`);
    process.exit(1);
  }

  const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
  const { loadTokens, deleteTokens } = await import("../providers/auth/token-store.js");

  const tokens = await loadTokens(provider);
  if (!tokens) {
    console.log(`No OAuth tokens stored for '${provider}'.`);
    return;
  }

  const cfg = await getOAuthProviderConfig(provider as ProviderId);
  if (cfg) {
    await cfg.provider.revoke(tokens); // best-effort
  }

  await deleteTokens(provider);
  const name = cfg?.displayName ?? provider;
  console.log(`Logged out of ${name}. OAuth tokens revoked and deleted.`);
}

export async function runKeysCleanupSettings(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_PATH, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No user-settings.json found — nothing to clean.");
      return;
    }
    throw e;
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`Settings file is not valid JSON: ${SETTINGS_PATH}`);
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${SETTINGS_PATH}.bak.${ts}`;
  await fs.writeFile(backup, raw, "utf8");

  let removed = 0;
  if ("apiKey" in json) {
    delete json.apiKey;
    removed++;
  }
  if (json.providers && typeof json.providers === "object") {
    const providers = json.providers as Record<string, Record<string, unknown>>;
    for (const [name, block] of Object.entries(providers)) {
      if (block && "apiKey" in block) {
        delete block.apiKey;
        removed++;
        if (Object.keys(block).length === 0) {
          delete providers[name];
        }
      }
    }
    if (Object.keys(providers).length === 0) {
      delete json.providers;
    }
  }

  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`Backed up to: ${backup}`);
  console.log(`Removed ${removed} plaintext key field(s) from: ${SETTINGS_PATH}`);
  if (removed === 0) {
    console.log("(File was already clean.)");
  }
}
