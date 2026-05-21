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

/**
 * If MUONROI_DEEPSEEK_DISABLE_THINKING=1 (default for self-qa), inject
 * `extra_body.thinking.type="disabled"` into every DeepSeek request per
 * https://api-docs.deepseek.com/guides/thinking_mode . Cuts response time
 * 30-50% and prevents reasoning prose from leaking into JSON outputs.
 *
 * Set MUONROI_DEEPSEEK_DISABLE_THINKING=0 to keep thinking mode on for
 * chat sessions that actually benefit from reasoning.
 */
function shouldDisableThinking(): boolean {
  const v = process.env["MUONROI_DEEPSEEK_DISABLE_THINKING"];
  return v === undefined ? false : v === "1" || v.toLowerCase() === "true";
}

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
      transformRequestBody: (body) => {
        if (shouldDisableThinking()) {
          return {
            ...body,
            thinking: { type: "disabled" },
          };
        }
        return body;
      },
    });
    return (modelId: string) => p(modelId);
  }
}
