/**
 * src/providers/strategies/opencode-go.strategy.ts
 *
 * OpenCode Go strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class OpenCodeGoStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "opencode-go";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("opencode-go");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS["opencode-go"],
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    return (modelId: string) => {
      // Strip 'opencode/' prefix if present
      const cleanId = modelId.startsWith("opencode/") ? modelId.slice(9) : modelId;
      return p(cleanId);
    };
  }
}
