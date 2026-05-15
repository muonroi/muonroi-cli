/**
 * src/providers/adapter.ts
 *
 * Registry/factory for getting an Adapter by ProviderId + ProviderConfig.
 * Central entry point for multi-provider streaming.
 */

import { createAnthropicAdapter } from "./anthropic.js";
import { loadTokensWithRefresh } from "./auth/openai-oauth.js";
import { apiBaseFor } from "./endpoints.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOllamaAdapter } from "./ollama.js";
import { createOpenAIAdapter } from "./openai.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderId, ProviderStream } from "./types.js";

// ---------------------------------------------------------------------------
// Mock-LLM provider hook (Task 3.1)
// When --mock-llm <dir> is active, globalThis.__muonroiMockLlm is set.
// Short-circuit all real provider calls with fixture responses.
// Inlined here to keep dep direction clean (providers must not import agent-harness).
// ---------------------------------------------------------------------------

type MockLlmInstance = { complete: (req: { prompt: string }) => Promise<{ text: string }> };

function createMockAdapter(id: ProviderId, mock: MockLlmInstance): Adapter {
  return {
    id,
    async *stream(req: AdapterRequest): ProviderStream {
      const prompt = req.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const res = await mock.complete({ prompt });
      yield { kind: "text-delta", text: res.text };
      yield { kind: "finish", reason: "stop" };
    },
  };
}

/**
 * Create an Adapter for the given provider.
 * For OpenAI, this is an async factory — call `createAdapterAsync` if you
 * need OAuth token auto-loading. `createAdapter` is kept synchronous for
 * backward compat but does NOT load OAuth tokens.
 */
export function createAdapter(id: ProviderId, config: ProviderConfig): Adapter {
  // Mock-LLM short-circuit: if the harness injected a mock, return it immediately.
  const mock = (globalThis as { __muonroiMockLlm?: MockLlmInstance }).__muonroiMockLlm;
  if (mock) {
    return createMockAdapter(id, mock);
  }

  switch (id) {
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      // Synchronous path: API-key only (no OAuth auto-load).
      // For OAuth support use createAdapterAsync().
      return createOpenAIAdapter(config);
    case "google":
      return createGeminiAdapter(config);
    case "deepseek":
      return createOpenAICompatibleAdapter({ ...config, id: "deepseek" });
    case "siliconflow":
      return createOpenAICompatibleAdapter({ ...config, id: "siliconflow" });
    case "xai":
      return createOpenAICompatibleAdapter({ ...config, id: "xai", baseURL: config.baseURL ?? apiBaseFor("xai") });
    case "ollama":
      return createOllamaAdapter(config);
  }
}

/**
 * Create an Adapter for the given provider, with OAuth auto-loading for OpenAI.
 * Use this instead of `createAdapter` whenever you need subscription-backed auth.
 *
 * For OpenAI:
 *   - Loads stored OAuth tokens (auto-refreshes if expiring within 60s).
 *   - If OAuth tokens exist, builds adapter with Bearer headers.
 *   - If no OAuth tokens, falls through to API-key path (backward compat).
 * For all other providers: identical to `createAdapter`.
 */
export async function createAdapterAsync(id: ProviderId, config: ProviderConfig): Promise<Adapter> {
  // Mock-LLM short-circuit
  const mock = (globalThis as { __muonroiMockLlm?: MockLlmInstance }).__muonroiMockLlm;
  if (mock) {
    return createMockAdapter(id, mock);
  }

  if (id === "openai") {
    const tokens = await loadTokensWithRefresh("openai").catch(() => null);
    if (tokens) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { openAIOAuth } = await import("./auth/openai-oauth.js");
      const oauthHeaders = openAIOAuth.authHeaders(tokens);
      return createOpenAIAdapter({ ...config, oauthHeaders });
    }
    // No OAuth tokens — fall through to API-key adapter
  }

  return createAdapter(id, config);
}

/**
 * All supported provider IDs in priority order.
 */
export const ALL_PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "siliconflow",
  "xai",
  "ollama",
];
