/**
 * src/providers/strategies/siliconflow.strategy.ts
 *
 * Phase 12.2-G4 — SiliconFlow strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class SiliconflowStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "siliconflow";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("siliconflow");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.siliconflow,
      apiKey: opts.apiKey,
    });
    return (modelId: string) => p(modelId);
  }
}
