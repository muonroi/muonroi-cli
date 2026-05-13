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

export const KEYCHAIN_PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "xai"];

/**
 * Store a provider API key in the OS keychain. Returns true on success.
 * Falls back to false (silent) if keytar is unavailable on this platform.
 */
export async function setKeyForProvider(provider: ProviderId, key: string): Promise<boolean> {
  if (!key || key.length < 20) {
    throw new Error(`Key for '${provider}' is too short (< 20 chars).`);
  }
  const kt = await loadKeytar();
  if (!kt?.setPassword) return false;
  redactor.enrollSecret(key);
  await kt.setPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_PROVIDER[provider], key);
  return true;
}

/**
 * Delete a stored key. Returns true if a key was deleted, false if none was
 * present or keytar is unavailable.
 */
export async function deleteKeyForProvider(provider: ProviderId): Promise<boolean> {
  const kt = await loadKeytar();
  if (!kt?.deletePassword) return false;
  return await kt.deletePassword(KEYCHAIN_SERVICE, ACCOUNT_BY_PROVIDER[provider]);
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
  const order: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "xai", "ollama"];
  const stored = new Set(await listStoredProviders());

  let settingsProviders: Record<string, { apiKey?: string }> = {};
  try {
    const { loadUserSettings } = await import("../utils/settings.js");
    settingsProviders = (loadUserSettings().providers ?? {}) as Record<string, { apiKey?: string }>;
  } catch {
    /* settings unreadable — keychain + env still work */
  }

  const configured: ProviderId[] = [];
  for (const p of order) {
    if (p === "ollama") {
      configured.push(p);
      continue;
    }
    if (stored.has(p)) {
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
 * Find the first provider with an available API key.
 * Checks in priority order: anthropic, openai, google, deepseek, siliconflow, ollama.
 * Returns null if no provider has a key (unlikely — ollama is keyless fallback).
 */
export async function firstAvailableProvider(): Promise<ProviderId | null> {
  const order: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"];
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
