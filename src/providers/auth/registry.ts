/**
 * src/providers/auth/registry.ts
 *
 * Single source of truth for OAuth-capable providers. Anything that needs
 * to know "which providers support subscription/OAuth login" reads from
 * here — adding a new provider (e.g. Anthropic, xAI) means appending one
 * entry, not touching keychain.ts / runtime.ts / keys.ts.
 *
 * Each entry carries:
 *   - `provider`: the ProviderOAuth implementation (login / refresh / revoke /
 *     authHeaders).
 *   - `baseURL` (optional): override the AI SDK baseURL when OAuth headers
 *     are injected. Required for providers whose subscription tokens hit a
 *     different backend than their API key (e.g. OpenAI's ChatGPT backend at
 *     chatgpt.com/backend-api/codex vs. api.openai.com).
 *   - `useResponsesApi` (optional): when true, the AI SDK's `.responses()`
 *     factory is used instead of the default chat completions factory.
 *     Set for endpoints that speak the OpenAI Responses API schema.
 *   - `loadTokensWithRefresh`: provider-specific token loader that handles
 *     pre-emptive refresh (each provider implements this itself because
 *     refresh response shapes differ).
 */

import type { ProviderId } from "../types.js";
import type { OAuthTokens, ProviderOAuth } from "./types.js";

/**
 * Subset of AI SDK call options that the orchestrator may need to strip when
 * a provider's OAuth backend doesn't accept them (e.g. ChatGPT Codex backend
 * rejects `max_output_tokens`).
 */
export type AISdkUnsupportedParam = "maxOutputTokens" | "temperature" | "topP";

export interface OAuthProviderConfig {
  provider: ProviderOAuth;
  /**
   * Human-friendly name shown in CLI prompts ("Logging in to <displayName>…").
   * Keep short — the registry is the single source of truth so the CLI layer
   * never needs a parallel display-name map.
   */
  displayName: string;
  baseURL?: string;
  useResponsesApi?: boolean;
  loadTokensWithRefresh: () => Promise<OAuthTokens | null>;
  /**
   * Provider-specific options merged into `providerOptions[<provider>]` on every
   * streamText call when this OAuth path is active. Use for backend-required
   * fields that AI SDK doesn't set by default (e.g. Codex backend requires
   * `instructions` and `store: false`).
   */
  defaultProviderOptions?: Record<string, unknown>;
  /**
   * Top-level streamText params to omit when this OAuth backend rejects them.
   * Honored by orchestrator before each streamText call.
   */
  unsupportedParams?: AISdkUnsupportedParam[];
}

let _registry: Partial<Record<ProviderId, OAuthProviderConfig>> | null = null;

/**
 * Lazy-load and cache the OAuth provider registry. Each provider module is
 * imported on demand so test suites that don't touch OAuth stay light.
 */
export async function loadOAuthRegistry(): Promise<Partial<Record<ProviderId, OAuthProviderConfig>>> {
  if (_registry) return _registry;
  const r: Partial<Record<ProviderId, OAuthProviderConfig>> = {};

  try {
    const { openAIOAuth, loadTokensWithRefresh } = await import("./openai-oauth.js");
    r.openai = {
      provider: openAIOAuth,
      displayName: "OpenAI (ChatGPT)",
      baseURL: "https://chatgpt.com/backend-api/codex",
      useResponsesApi: true,
      loadTokensWithRefresh: () => loadTokensWithRefresh("openai"),
      // ChatGPT Codex backend requires `instructions` and `store: false` (see
      // codex-rs/codex-api/src/common.rs::ResponsesApiRequest) and rejects
      // `max_output_tokens` (not part of the backend schema).
      defaultProviderOptions: {
        instructions: "You are a coding agent running in the Muonroi CLI.",
        store: false,
      },
      unsupportedParams: ["maxOutputTokens"],
    };
  } catch {
    /* openai-oauth unavailable */
  }

  try {
    const { agyOAuth, loadAgyTokensWithRefresh, loadCustomOAuthTokens } = await import("./gemini-oauth.js");
    const { loadGcloudToken } = await import("./gcloud.js");

    r.google = {
      provider: agyOAuth,
      displayName: "Agy",
      // baseURL intentionally left undefined for the google provider.
      // When OAuth tokens are present, the custom fetch-based provider in
      // google.strategy.ts (Approach A) uses the user-specified baseURL from
      // settings, or falls back to generativelanguage.googleapis.com/v1beta.
      // The old hardcoded cloudcode-pa.googleapis.com endpoint is dead.
      //
      // Token loading chain (Approach B + C):
      //   1. Custom OAuth client from env vars MUONROI_GOOGLE_CLIENT_ID/SECRET
      //      or settings providers.google.oauthClientId/oauthClientSecret
      //   2. gcloud ADC (~/.config/gcloud/application_default_credentials.json)
      //   3. Agy OAuth tokens from ~/.gemini/oauth_creds.json (legacy)
      loadTokensWithRefresh: async () => {
        // Approach C: try custom OAuth client first (user-registered GCP client)
        const custom = await loadCustomOAuthTokens().catch(() => null);
        if (custom) return custom;

        // Approach B: try gcloud ADC (works immediately after gcloud auth login)
        const gcloud = await loadGcloudToken().catch(() => null);
        if (gcloud) return gcloud;

        // Legacy fallback: Agy tokens from ~/.gemini/oauth_creds.json
        return loadAgyTokensWithRefresh();
      },
    };
  } catch {
    /* agy-oauth unavailable */
  }

  try {
    const { grokOAuth, loadGrokTokensWithRefresh } = await import("./grok-oauth.js");
    r.xai = {
      provider: grokOAuth,
      displayName: "xAI (Grok)",
      // xAI subscription (SuperGrok / X Premium+) OAuth tokens hit the SAME
      // api.x.ai/v1 host as API-key auth (unlike OpenAI, whose subscription
      // tokens require a separate ChatGPT backend). baseURL is therefore left
      // undefined so the api-key endpoint from endpoints.ts flows through; the
      // strategy injects the Bearer header on the OpenAI-compatible path.
      useResponsesApi: true,
      loadTokensWithRefresh: () => loadGrokTokensWithRefresh(),
    };
  } catch {
    /* grok-oauth unavailable */
  }

  _registry = r;
  return r;
}

/** List provider ids that have an OAuth implementation registered. */
export async function listOAuthProviderIds(): Promise<ProviderId[]> {
  const reg = await loadOAuthRegistry();
  return Object.keys(reg) as ProviderId[];
}

/** Return the OAuth config for a provider, or undefined if not OAuth-capable. */
export async function getOAuthProviderConfig(id: ProviderId): Promise<OAuthProviderConfig | undefined> {
  const reg = await loadOAuthRegistry();
  return reg[id];
}

/** TEST ONLY — reset the cache. Production code should never call this. */
export function _resetOAuthRegistry(): void {
  _registry = null;
}
