/**
 * src/providers/strategies/deepseek.strategy.ts
 *
 * Phase 12.2-G4 — DeepSeek strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";
import { transformThinkingModeBody } from "./thinking-mode.js";

export class DeepSeekStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "deepseek";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("deepseek");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.deepseek,
      apiKey: opts.apiKey,
      // DeepSeek understands OpenAI's response_format={type:"json_object"}
      // but NOT response_format={type:"json_schema",schema:...}. Setting
      // supportsStructuredOutputs=false makes AI SDK send the simpler
      // json_object form for generateObject calls, matching DeepSeek docs:
      // https://api-docs.deepseek.com/guides/json_mode .
      supportsStructuredOutputs: false,
      // Thinking-mode round-trip fix: backfill reasoning_content (default) or
      // disable thinking (MUONROI_DEEPSEEK_DISABLE_THINKING=1). See
      // thinking-mode.ts for the full rationale (code 20015 rejection).
      transformRequestBody: (body) => transformThinkingModeBody(body),
    });
    return (modelId: string) => p(modelId);
  }
}
