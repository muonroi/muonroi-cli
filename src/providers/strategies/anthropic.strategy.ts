/**
 * src/providers/strategies/anthropic.strategy.ts
 *
 * Phase 12.2-G4 — Anthropic provider strategy. Wraps `@ai-sdk/anthropic`
 * and exposes both `chat` and `responses` model factories.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class AnthropicStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "anthropic";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("anthropic");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createAnthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    const factory: ProviderFactory = (modelId: string) => p(modelId);
    // biome-ignore lint/suspicious/noExplicitAny: ai-sdk responses() typed any
    factory.responses = (modelId: string) => (p as any).responses(modelId);
    return factory;
  }
}
