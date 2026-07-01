/**
 * src/providers/strategies/zai.strategy.ts
 *
 * Z.ai strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class ZaiStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "zai";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("zai");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.zai,
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    return (modelId: string) => p(modelId);
  }
}
