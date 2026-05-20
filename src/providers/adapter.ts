/**
 * src/providers/adapter.ts
 *
 * Registry/factory for getting an `Adapter` by ProviderId + ProviderConfig.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Two streaming code paths exist — pick the right one:
 *
 *   1. `Adapter` (this file)
 *      Raw `Adapter.stream(req)` interface returning a `ProviderStream`
 *      iterator of `text-delta` / `tool-call` / `finish` events. Used by:
 *        • agent-harness mock-LLM path (`__muonroiMockLlm` short-circuit)
 *        • legacy / smoke-test code paths that need a uniform streaming shape
 *        • integration points that consume normalized provider events
 *      Always go through `createAdapter` / `createAdapterAsync` so OAuth +
 *      mock-LLM hooks are honored uniformly.
 *
 *   2. `ProviderStrategy.resolve()` + AI-SDK `streamText()`
 *      (`src/providers/strategies/` + `src/providers/runtime.ts`)
 *      The orchestrator path. Returns an AI-SDK `LanguageModelV3` handle plus
 *      `providerOptions` / `unsupportedParams` so the orchestrator can call
 *      `streamText({ model, providerOptions, tools, ... })` directly. Carries
 *      per-provider capability info (Responses API gating, prompt-cache keys,
 *      reasoning options) that the raw Adapter path does not need.
 *      Use this in `src/orchestrator/`, `src/router/`, agentic tool loops.
 *
 * Rule of thumb: orchestrator / tool-loop / cost-tracking code wants
 * strategy + streamText. Test harnesses, mock paths, and uniform-event
 * consumers want Adapter.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createAnthropicAdapter } from "./anthropic.js";
import { getOAuthProviderConfig } from "./auth/registry.js";
import { apiBaseFor } from "./endpoints.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOllamaAdapter } from "./ollama.js";
import { createOpenAIAdapter } from "./openai.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderId, ProviderStream } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";

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
 * Per-provider Adapter factory registry. Adding a new provider means
 * appending one entry here — no `switch` / `if (id === ...)` anywhere else.
 *
 * Each entry receives the validated `ProviderConfig` and returns an Adapter.
 * OpenAI-compatible providers (deepseek/siliconflow/xai) share one factory
 * with provider-specific config tweaks; that is per-provider configuration,
 * not branching logic.
 */
type AdapterFactory = (config: ProviderConfig) => Adapter;

const ADAPTER_FACTORIES: Record<ProviderId, AdapterFactory> = {
  anthropic: (config) => createAnthropicAdapter(config),
  // Synchronous path: API-key only (no OAuth auto-load). Use createAdapterAsync for OAuth.
  openai: (config) => createOpenAIAdapter(config),
  google: (config) => createGeminiAdapter(config),
  deepseek: (config) => createOpenAICompatibleAdapter({ ...config, id: "deepseek" }),
  siliconflow: (config) => createOpenAICompatibleAdapter({ ...config, id: "siliconflow" }),
  xai: (config) =>
    createOpenAICompatibleAdapter({ ...config, id: "xai", baseURL: config.baseURL ?? apiBaseFor("xai") }),
  ollama: (config) => createOllamaAdapter(config),
};

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

  const factory = ADAPTER_FACTORIES[id];
  if (!factory) {
    throw new Error(`No adapter factory registered for provider '${id}'`);
  }
  return factory(config);
}

/**
 * Create an Adapter for the given provider, with OAuth auto-loading for any
 * provider registered in `providers/auth/registry.ts`.
 *
 * Dispatch is registry-driven — no `if (id === "openai")` branching. To add
 * OAuth for a new provider (Anthropic, etc.):
 *   1. Register the provider in `providers/auth/registry.ts`.
 *   2. Ensure its adapter honors `config.oauthHeaders` (see openai.ts/anthropic.ts/gemini.ts).
 *
 * Behavior per provider:
 *   - OAuth tokens present (auto-refreshed) → adapter built with Bearer headers,
 *     optional baseURL override from registry.
 *   - No OAuth tokens or provider not in registry → fall through to API-key path.
 */
export async function createAdapterAsync(id: ProviderId, config: ProviderConfig): Promise<Adapter> {
  // Mock-LLM short-circuit
  const mock = (globalThis as { __muonroiMockLlm?: MockLlmInstance }).__muonroiMockLlm;
  if (mock) {
    return createMockAdapter(id, mock);
  }

  try {
    const cfg = await getOAuthProviderConfig(id);
    if (cfg) {
      const tokens = await cfg.loadTokensWithRefresh().catch(() => null);
      if (tokens) {
        const oauthHeaders = cfg.provider.authHeaders(tokens);
        // OAuth tokens may target a different backend than API-key auth
        // (e.g. OpenAI's ChatGPT Codex endpoint). Registry config wins unless
        // the caller pinned an explicit baseURL.
        const baseURL = config.baseURL ?? cfg.baseURL;
        return createAdapter(id, { ...config, baseURL, oauthHeaders });
      }
    }
  } catch {
    /* registry unavailable or token load failed — fall through to API key */
  }

  return createAdapter(id, config);
}

/**
 * All supported provider IDs in priority order.
 * Phase 12.2-G5: re-export from types.ts (single source of truth) so existing
 * importers of `./adapter` continue to work unchanged.
 */
export { ALL_PROVIDER_IDS };
