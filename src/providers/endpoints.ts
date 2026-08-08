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
    // `/v1` is REQUIRED: the Messages endpoint is `/v1/messages`, and
    // `@ai-sdk/anthropic` defaults to `https://api.anthropic.com/v1`. Without it,
    // any caller that actually threads this value (a user-set
    // `providers.anthropic.baseURL`, or the vision-proxy slot resolver) builds
    // `https://api.anthropic.com/messages` and 404s. Harmless only while every
    // caller happens to leave baseURL undefined — not a property worth relying on.
    apiBase: "https://api.anthropic.com/v1",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    apiBase: "https://api.openai.com/v1",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  deepseek: {
    apiBase: "https://api.deepseek.com",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  xai: {
    apiBase: "https://api.x.ai/v1",
    consoleUrl: "https://console.x.ai/",
  },
  ollama: {
    apiBase: "http://localhost:11434",
    consoleUrl: "(no key needed for Ollama)",
  },
  zai: {
    apiBase: "https://api.z.ai/api/coding/paas/v4",
    consoleUrl: "https://z.ai/coding-plan",
  },
  "opencode-go": {
    apiBase: "https://opencode.ai/zen/go/v1",
    consoleUrl: "https://opencode.ai",
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
 * True when `url` is some provider's built-in default apiBase.
 *
 * The distinction it encodes: a base URL equal to a default is *derived* state
 * (it came from `getBaseURL()` at startup and belongs to whichever provider was
 * current then), so it must be dropped when the provider changes. Anything else
 * is a deliberate user override (a third-party gateway / proxy) and is treated
 * as such by `createProviderFactory`.
 */
export function isProviderDefaultApiBase(url: string | null | undefined): boolean {
  if (!url) return false;
  for (const endpoint of Object.values(PROVIDER_ENDPOINTS)) {
    if (url === endpoint.apiBase) return true;
  }
  return false;
}

/**
 * Default base URLs for OpenAI-compatible providers only. Used by adapters
 * that share the OpenAI SDK shape (deepseek, xai).
 */
export const OPENAI_COMPATIBLE_BASE_URLS: Record<"deepseek" | "xai" | "zai" | "opencode-go", string> = {
  deepseek: PROVIDER_ENDPOINTS.deepseek.apiBase,
  xai: PROVIDER_ENDPOINTS.xai.apiBase,
  zai: PROVIDER_ENDPOINTS.zai.apiBase,
  "opencode-go": PROVIDER_ENDPOINTS["opencode-go"].apiBase,
};
