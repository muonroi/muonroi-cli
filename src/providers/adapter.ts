/**
 * src/providers/adapter.ts
 *
 * Registry/factory for getting an Adapter by ProviderId + ProviderConfig.
 * Central entry point for multi-provider streaming.
 */

import { createAnthropicAdapter } from "./anthropic.js";
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
