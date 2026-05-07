/**
 * Single source of truth for provider API base URLs and console URLs.
 *
 * Every other module should import from here — never inline a provider URL.
 * If a provider changes domain (e.g. region split), this is the only file
 * that needs to update.
 *
 * `apiBase`     — base URL the SDK / fetch hits for chat/completions, etc.
 * `consoleUrl`  — human dashboard for issuing API keys (used by the wizard).
 */

import type { ProviderId } from "./types.js";

export interface ProviderEndpoints {
  apiBase: string;
  consoleUrl: string;
}

export const PROVIDER_ENDPOINTS: Record<ProviderId, ProviderEndpoints> = {
  anthropic: {
    apiBase: "https://api.anthropic.com",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    apiBase: "https://api.openai.com/v1",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    apiBase: "https://generativelanguage.googleapis.com/v1beta",
    consoleUrl: "https://aistudio.google.com/app/apikey",
  },
  deepseek: {
    apiBase: "https://api.deepseek.com",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  siliconflow: {
    apiBase: "https://api.siliconflow.com/v1",
    consoleUrl: "https://cloud.siliconflow.com/account/ak",
  },
  xai: {
    apiBase: "https://api.x.ai/v1",
    consoleUrl: "https://console.x.ai/",
  },
  ollama: {
    apiBase: "http://localhost:11434",
    consoleUrl: "(no key needed for Ollama)",
  },
};

/** Fast lookup: provider id → API base URL. */
export function apiBaseFor(provider: ProviderId): string {
  return PROVIDER_ENDPOINTS[provider].apiBase;
}

/** Fast lookup: provider id → human console URL for issuing keys. */
export function consoleUrlFor(provider: ProviderId): string {
  return PROVIDER_ENDPOINTS[provider].consoleUrl;
}

/**
 * Default base URLs for OpenAI-compatible providers only. Used by adapters
 * that share the OpenAI SDK shape (deepseek, siliconflow, xai).
 */
export const OPENAI_COMPATIBLE_BASE_URLS: Record<"deepseek" | "siliconflow" | "xai", string> = {
  deepseek: PROVIDER_ENDPOINTS.deepseek.apiBase,
  siliconflow: PROVIDER_ENDPOINTS.siliconflow.apiBase,
  xai: PROVIDER_ENDPOINTS.xai.apiBase,
};
