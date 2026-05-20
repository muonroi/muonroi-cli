/**
 * src/providers/strategies/openai.strategy.ts
 *
 * Phase 12.2-G4 — OpenAI provider strategy. Two code paths:
 *   - API-key path: standard `createOpenAI` + chat completions / responses.
 *     Defaults `store: true` on `factory.defaultProviderOptions` so logs
 *     persist in the OpenAI dashboard (orchestrator policy migrated here
 *     in G4).
 *   - OAuth (ChatGPT subscription) path: hits
 *     https://chatgpt.com/backend-api/codex with Bearer headers via the
 *     Responses API only. OAuth registry layers `store: false` +
 *     `instructions` on top of the factory defaults — see
 *     src/providers/auth/openai-oauth.ts.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class OpenAIStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "openai";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("openai");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    // OAuth subscription tokens cannot call api.openai.com — they must hit
    // ChatGPT's backend (https://chatgpt.com/backend-api/codex) using the
    // Responses API, not Chat Completions.
    const isOAuth = !!opts.headers;
    const p = isOAuth
      ? createOpenAI({
          apiKey: opts.apiKey ?? "oauth",
          baseURL: opts.baseURL ?? "https://chatgpt.com/backend-api/codex",
          headers: opts.headers,
        })
      : createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });

    const factory: ProviderFactory = isOAuth
      ? // biome-ignore lint/suspicious/noExplicitAny: ai-sdk responses() typed any
        (modelId: string) => (p as any).responses(modelId)
      : (modelId: string) => p(modelId);
    // biome-ignore lint/suspicious/noExplicitAny: ai-sdk responses() typed any
    factory.responses = (modelId: string) => (p as any).responses(modelId);

    // API-key path: enable `store: true` so logs persist in the OpenAI
    // dashboard. OAuth path: providerLevelDefaults from the auth registry
    // sets `store: false` and overrides this baseline.
    if (!isOAuth) {
      factory.defaultProviderOptions = { store: true };
    }

    return factory;
  }
}
