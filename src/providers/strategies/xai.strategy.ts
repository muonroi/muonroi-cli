/**
 * src/providers/strategies/xai.strategy.ts
 *
 * Phase 12.2-G4 — xAI (Grok) strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class XAIStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "xai";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("xai");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    // Subscription OAuth path: `opts.headers` carries the Bearer token. xAI's
    // OAuth token is accepted on the same api.x.ai/v1 OpenAI-compatible host as
    // an API key (both /chat/completions and /responses), so the only change vs
    // the key path is injecting the header. `apiKey` falls back to a placeholder
    // because @ai-sdk/openai-compatible always sets an Authorization header from
    // it, but the explicit `headers` entry overrides that placeholder.
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.xai,
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    return (modelId: string) => p(modelId);
  }
}
