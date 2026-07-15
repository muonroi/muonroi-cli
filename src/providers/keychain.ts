/**
 * src/providers/keychain.ts
 *
 * Per-provider key store. Backed by the env-store (`.env` file + process.env +
 * Windows registry mirror) — the OS keychain (keytar) has been removed.
 *
 * Source of truth: `process.env[ENV_BY_PROVIDER[provider]]`. Writes go through
 * the env-store; reads come straight from process.env.
 * Exception: ollama is keyless by default.
 */

import { redactor } from "../utils/redactor.js";
import { clearEnvVar, persistEnvVar } from "./env-store.js";
import type { ProviderId } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";

function normalizeKeychainProvider(p: string): ProviderId | null {
  const lower = p.toLowerCase();
  if ((ALL_PROVIDER_IDS as readonly string[]).includes(lower)) return lower as ProviderId;
  return null;
}

const ENV_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  ollama: "OLLAMA_API_KEY",
  zai: "ZAI_API_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
};

/**
 * Thrown when no API key can be found for a provider.
 */
export class ProviderKeyMissingError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`No API key found for provider '${provider}'.`);
    this.name = "ProviderKeyMissingError";
  }
}

/**
 * Providers that store an API key (all except keyless ollama). Derived from
 * `ALL_PROVIDER_IDS`; preserves the original ordering.
 */
export const KEYCHAIN_PROVIDER_IDS: readonly ProviderId[] = ALL_PROVIDER_IDS.filter((p) => p !== "ollama");

/**
 * Store a provider API key in the OS environment (via the env-store: `.env`
 * file + process.env + Windows registry mirror). Returns true on success.
 */
export async function setKeyForProvider(provider: string | ProviderId, key: string): Promise<boolean> {
  const norm = normalizeKeychainProvider(provider as string) ?? (provider as ProviderId);
  if (!key || key.length < 20) {
    throw new Error(`Key for '${provider}' is too short (< 20 chars).`);
  }
  persistEnvVar(ENV_BY_PROVIDER[norm], key);
  return true;
}

/**
 * Delete a stored key from the env-store. Returns true if a key was present.
 */
export async function deleteKeyForProvider(provider: string | ProviderId): Promise<boolean> {
  const norm = normalizeKeychainProvider(provider as string) ?? (provider as ProviderId);
  const had = !!process.env[ENV_BY_PROVIDER[norm]];
  clearEnvVar(ENV_BY_PROVIDER[norm]);
  return had;
}

/**
 * List provider IDs that currently have a key set in the environment.
 */
export async function listStoredProviders(): Promise<ProviderId[]> {
  return KEYCHAIN_PROVIDER_IDS.filter((p) => {
    const v = process.env[ENV_BY_PROVIDER[p]];
    return !!v && v.length >= 20;
  });
}

/**
 * Load the API key for a given provider from the environment.
 * Ollama returns '' when no key is found (keyless).
 *
 * @throws {ProviderKeyMissingError} when no key found for non-ollama providers.
 */
export async function loadKeyForProvider(provider: ProviderId): Promise<string> {
  const envKey = process.env[ENV_BY_PROVIDER[provider]];
  if (envKey && envKey.length >= 20) {
    redactor.enrollSecret(envKey);
    return envKey;
  }

  // Ollama may be keyless
  if (provider === "ollama") return "";

  throw new ProviderKeyMissingError(provider);
}

/**
 * Return the list of providers that currently have credentials available — checked across
 * OS keychain, environment variables, and user-settings.json. `ollama` is always included
 * because it is keyless. Order is stable for UI rendering.
 */
export async function getConfiguredProviders(): Promise<ProviderId[]> {
  const order: readonly ProviderId[] = ALL_PROVIDER_IDS;
  const stored = new Set(await listStoredProviders());

  // OAuth-authenticated providers (no API key, but tokens stored via `keys
  // login`) need to count as configured — otherwise the model picker silently
  // hides them. Source the eligible provider list from the OAuth registry so
  // adding a new OAuth provider in registry.ts automatically wires it up here.
  const oauthAuthenticated = new Set<ProviderId>();
  try {
    const { listOAuthProviderIds } = await import("./auth/registry.js");
    const { loadTokens } = await import("./auth/token-store.js");
    for (const p of await listOAuthProviderIds()) {
      const t = await loadTokens(p).catch(() => null);
      if (t?.accessToken) oauthAuthenticated.add(p);
    }
  } catch {
    /* registry/token-store unreadable — fall through */
  }

  const configured: ProviderId[] = [];
  for (const p of order) {
    if (p === "ollama" || stored.has(p) || oauthAuthenticated.has(p)) {
      configured.push(p);
    }
  }
  return configured;
}

/**
 * Load OAuth tokens for a provider with auto-refresh.
 * Returns null if no OAuth tokens are stored for that provider.
 * This is a thin helper over token-store + openai-oauth; exported here so
 * higher-level code (CLI, adapter) has a single import point.
 */
export async function getOAuthTokens(provider: ProviderId): Promise<import("./auth/types.js").OAuthTokens | null> {
  if (provider !== "openai") return null; // only openai supported in Phase 18
  try {
    const { loadTokensWithRefresh } = await import("./auth/openai-oauth.js");
    return await loadTokensWithRefresh("openai");
  } catch {
    return null;
  }
}

/**
 * Find the first provider with an available API key.
 * Checks in priority order: anthropic, openai, deepseek, ollama.
 * Returns null if no provider has a key (unlikely — ollama is keyless fallback).
 */
export async function firstAvailableProvider(): Promise<ProviderId | null> {
  // firstAvailableProvider intentionally excludes xai: priority list for legacy
  // fallback paths that pre-date xai integration. Derived from ALL_PROVIDER_IDS
  // to keep ordering in sync if new providers are added.
  const order: readonly ProviderId[] = ALL_PROVIDER_IDS.filter((p) => p !== "xai");
  for (const p of order) {
    try {
      await loadKeyForProvider(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Minimal shape of the legacy keytar module, loaded best-effort. */
interface LegacyKeytar {
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * One-time migration: move any legacy API keys — OS keychain (keytar) or
 * `settings.json` (`providers.<p>.apiKey`) — into the env-store, then remove
 * the legacy copies. Best-effort, idempotent, and never throws. Guarded by
 * `settings.keysMigratedToEnv`. Runs once at startup before key resolution.
 */
export async function migrateLegacyKeysToEnv(): Promise<void> {
  let settingsMod: typeof import("../utils/settings.js");
  try {
    settingsMod = await import("../utils/settings.js");
  } catch (err) {
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[keychain] migration: settings unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  let settings: import("../utils/settings.js").UserSettings;
  try {
    settings = settingsMod.loadUserSettings();
  } catch {
    return;
  }
  if (settings.keysMigratedToEnv) return;

  // Legacy keytar reader — the module is being removed, so absence is normal.
  let keytar: LegacyKeytar | null = null;
  try {
    keytar = (await import("keytar")) as unknown as LegacyKeytar;
  } catch {
    keytar = null;
  }

  const providersPatch = { ...(settings.providers ?? {}) } as Record<string, { apiKey?: string; baseURL?: string }>;
  let providersDirty = false;

  for (const p of KEYCHAIN_PROVIDER_IDS) {
    const envName = ENV_BY_PROVIDER[p];
    if (process.env[envName]) continue; // already in env

    let legacy: string | null = null;
    if (keytar?.getPassword) {
      try {
        legacy = await keytar.getPassword("muonroi-cli", p);
      } catch {
        legacy = null;
      }
    }
    if (!legacy) legacy = providersPatch[p]?.apiKey ?? null;

    if (legacy && legacy.length >= 20) {
      persistEnvVar(envName, legacy);
      if (keytar?.deletePassword) {
        try {
          await keytar.deletePassword("muonroi-cli", p);
        } catch {
          /* best-effort keychain cleanup */
        }
      }
      if (providersPatch[p]?.apiKey) {
        delete providersPatch[p].apiKey;
        providersDirty = true;
      }
    }
  }

  const patch: Partial<import("../utils/settings.js").UserSettings> = { keysMigratedToEnv: true };
  // Strip the legacy plaintext main key — it is no longer read (getApiKey is
  // env-only). Passing undefined drops it from the persisted JSON.
  if (settings.apiKey) patch.apiKey = undefined;
  if (providersDirty) patch.providers = providersPatch as import("../utils/settings.js").UserSettings["providers"];
  try {
    settingsMod.saveUserSettings(patch);
  } catch (err) {
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[keychain] migration: save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
