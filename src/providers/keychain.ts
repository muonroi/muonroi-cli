/**
 * src/providers/keychain.ts
 *
 * Per-provider keychain loader with env-var fallback.
 * Extends the Phase 0 loadAnthropicKey pattern to all 6 providers.
 * PROV-02 / PROV-03 requirements.
 *
 * Priority: OS keychain (keytar) > environment variable > settings.json > ProviderKeyMissingError.
 * Exception: ollama is keyless by default.
 */

import { redactor } from "../utils/redactor.js";
import type { ProviderId } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";

function normalizeKeychainProvider(p: string): ProviderId | null {
  const lower = p.toLowerCase();
  if (lower === "agy") return "google"; // agy alias for google provider
  if ((ALL_PROVIDER_IDS as readonly string[]).includes(lower)) return lower as ProviderId;
  return null;
}

const SETTINGS_KEY_MAP: Partial<Record<ProviderId, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  siliconflow: "siliconflow",
  xai: "xai",
};

const KEYCHAIN_SERVICE = "muonroi-cli";

const ACCOUNT_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  siliconflow: "siliconflow",
  xai: "xai",
  ollama: "ollama",
};

const ENV_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  xai: "XAI_API_KEY",
  ollama: "OLLAMA_API_KEY",
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
 * Dynamic keytar loader — B-2 mitigation.
 * Missing/broken keytar never crashes the process.
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword?(service: string, account: string, password: string): Promise<void>;
  deletePassword?(service: string, account: string): Promise<boolean>;
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    return (await import("keytar")) as KeytarLike;
  } catch {
    return null;
  }
}

/**
 * Providers that store an API key in the OS keychain.
 * Phase 12.2-G5: derived from `ALL_PROVIDER_IDS` by excluding ollama
 * (keyless local server). Preserves the original ordering.
 */
export const KEYCHAIN_PROVIDER_IDS: readonly ProviderId[] = ALL_PROVIDER_IDS.filter((p) => p !== "ollama");

/**
 * Store a provider API key in the OS keychain. Returns true on success.
 * Falls back to false (silent) if keytar is unavailable on this platform.
 */
export async function setKeyForProvider(provider: string | ProviderId, key: string): Promise<boolean> {
  const norm = normalizeKeychainProvider(provider as string) ?? (provider as ProviderId);
  if (!key || key.length < 20) {
    throw new Error(`Key for '${provider}' is too short (< 20 chars).`);
  }
  const kt = await loadKeytar();
  if (!kt?.setPassword) return false;
  redactor.enrollSecret(key);
  try {
    await kt.setPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_PROVIDER[norm], key);
    return true;
  } catch (err: any) {
    // Runtime backend failure is common on Linux when libsecret / secret service
    // (gnome-keyring, kwallet/ksecretd, etc.) is not installed, the collection is
    // locked, or no D-Bus session/keyring is active for this user.
    // The caller (e.g. keys import-bw / keys set) will print the friendly message.
    if (process.env.DEBUG || process.env.MUONROI_DEBUG_KEYCHAIN) {
      console.error(`[keychain] setPassword backend error for ${provider}:`, err?.message || err);
    }
    return false;
  }
}

/**
 * Delete a stored key. Returns true if a key was deleted, false if none was
 * present or keytar is unavailable.
 */
export async function deleteKeyForProvider(provider: string | ProviderId): Promise<boolean> {
  const norm = normalizeKeychainProvider(provider as string) ?? (provider as ProviderId);
  const kt = await loadKeytar();
  if (!kt?.deletePassword) return false;
  try {
    return await kt.deletePassword(KEYCHAIN_SERVICE, ACCOUNT_BY_PROVIDER[norm]);
  } catch (err: any) {
    if (process.env.DEBUG || process.env.MUONROI_DEBUG_KEYCHAIN) {
      console.error(`[keychain] deletePassword backend error for ${provider}:`, err?.message || err);
    }
    return false;
  }
}

/**
 * List provider IDs that currently have a key stored in the keychain.
 * Empty array if keytar is unavailable.
 */
export async function listStoredProviders(): Promise<ProviderId[]> {
  const kt = await loadKeytar();
  if (!kt?.findCredentials) return [];
  try {
    const creds = await kt.findCredentials(KEYCHAIN_SERVICE);
    const validAccounts = new Set(Object.values(ACCOUNT_BY_PROVIDER));
    return creds.filter((c) => validAccounts.has(c.account)).map((c) => c.account as ProviderId);
  } catch {
    return [];
  }
}

/**
 * Load the API key for a given provider.
 * Priority: OS keychain (keytar) > environment variable.
 * Ollama returns '' when no key is found (keyless).
 *
 * @throws {ProviderKeyMissingError} when no key found for non-ollama providers.
 */
export async function loadKeyForProvider(provider: ProviderId): Promise<string> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      const k = await kt.getPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_PROVIDER[provider]);
      if (k && k.length >= 20) {
        redactor.enrollSecret(k);
        return k;
      }
    } catch {
      /* ignore keytar backend failures */
    }
  }

  const envKey = process.env[ENV_BY_PROVIDER[provider]];
  if (envKey && envKey.length >= 20) {
    redactor.enrollSecret(envKey);
    return envKey;
  }

  // Fallback: check user-settings.json providers config (lazy import to avoid circular deps)
  const settingsField = SETTINGS_KEY_MAP[provider];
  if (settingsField) {
    try {
      const { loadUserSettings } = await import("../utils/settings.js");
      const providers = loadUserSettings().providers as Record<string, { apiKey?: string }> | undefined;
      const settingsKey = providers?.[settingsField]?.apiKey;
      if (settingsKey && settingsKey.length >= 20) {
        redactor.enrollSecret(settingsKey);
        return settingsKey;
      }
    } catch {
      /* settings load failed — continue to error */
    }
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

  let settingsProviders: Record<string, { apiKey?: string }> = {};
  try {
    const { loadUserSettings } = await import("../utils/settings.js");
    settingsProviders = (loadUserSettings().providers ?? {}) as Record<string, { apiKey?: string }>;
  } catch {
    /* settings unreadable — keychain + env still work */
  }

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
    if (p === "ollama") {
      configured.push(p);
      continue;
    }
    if (stored.has(p) || oauthAuthenticated.has(p)) {
      configured.push(p);
      continue;
    }
    const envKey = process.env[ENV_BY_PROVIDER[p]];
    if (envKey && envKey.length >= 20) {
      configured.push(p);
      continue;
    }
    const settingsField = SETTINGS_KEY_MAP[p];
    if (settingsField) {
      const k = settingsProviders[settingsField]?.apiKey;
      if (k && k.length >= 20) {
        configured.push(p);
      }
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
 * Checks in priority order: anthropic, openai, google, deepseek, siliconflow, ollama.
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
