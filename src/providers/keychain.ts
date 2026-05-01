/**
 * src/providers/keychain.ts
 *
 * Per-provider keychain loader with env-var fallback.
 * Extends the Phase 0 loadAnthropicKey pattern to all 6 providers.
 * PROV-02 / PROV-03 requirements.
 *
 * Priority: OS keychain (keytar) > environment variable > ProviderKeyMissingError.
 * Exception: ollama is keyless by default.
 */

import { redactor } from "../utils/redactor.js";
import type { ProviderId } from "./types.js";

const KEYCHAIN_SERVICE = "muonroi-cli";

const ACCOUNT_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  siliconflow: "siliconflow",
  ollama: "ollama",
};

const ENV_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
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
async function loadKeytar(): Promise<{ getPassword(s: string, a: string): Promise<string | null> } | null> {
  try {
    return (await import("keytar")) as any;
  } catch {
    return null;
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

  // Ollama may be keyless
  if (provider === "ollama") return "";

  throw new ProviderKeyMissingError(provider);
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
