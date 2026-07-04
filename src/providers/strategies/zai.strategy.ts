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
import { transformZaiThinkingBody } from "./thinking-mode.js";

export class ZaiStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "zai";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("zai");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.zai,
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),

      // Many Z.ai users (especially Coding Plan) hit 1210 / empty responses
      // when using the wrong baseURL or when the SDK sends extra fields.
      // Default is the coding/paas/v4 endpoint (matching opencode recommendations).
      // Users can override via --base-url or provider config for the standard paas.
      // Z.ai coding endpoint (api.z.ai/api/coding/paas/v4) auto-enables
      // thinking for GLM-4.7 / GLM-5.x. In a multi-step tool loop some
      // intermediate assistant turns carry tool_calls WITHOUT reasoning, so
      // @ai-sdk/openai-compatible serializes them without a reasoning_content
      // key → Z.ai rejects the whole request with HTTP 400 / code 1210
      // "Invalid API parameter".
      //
      // We follow patterns seen in other mature clients (e.g. opencode) for
      // robust GLM coding plan usage:
      // - Conditional reasoning_content backfill (onlyIfMixed)
      // - Force parallel_tool_calls: false (model still sometimes batches 2-5)
      // - Drop null response_format (fragile with tools)
      // - Clamp max_tokens, normalize tool-only assistant content shape
      //
      // See transformZaiThinkingBody for the full sanitization.
      transformRequestBody: (body) => transformZaiThinkingBody(body),
    });
    return (modelId: string) => p(modelId);
  }
}
