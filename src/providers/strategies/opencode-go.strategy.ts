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
import {
  backfillReasoningContent,
  sanitizeToolCallArguments,
  splitParallelToolCalls,
  transformThinkingModeBody,
  transformZaiThinkingBody,
} from "./thinking-mode.js";

export class OpenCodeGoStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "opencode-go";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("opencode-go");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS["opencode-go"],
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),
      // DeepSeek models (common via opencode-go) do not support full json_schema,
      // only json_object. Prevent AI SDK from sending unsupported schema.
      supportsStructuredOutputs: false,
      // Apply thinking-mode transform for deepseek models routed via opencode-go (e.g. deepseek-v4-flash).
      // The opencode Console Go backend forwards to DeepSeek, which requires reasoning_content
      // roundtrips (like direct DeepSeek). Without it, histories with tool calls produce
      // "Upstream request failed" / invalid_request_error (observed in session 53f3c3ea4ae8).
      // Inspect body.model (after possible prefix) to apply only when appropriate.
      transformRequestBody: (body) => {
        const modelInBody = (body as any)?.model || "";
        const isDeepseekModel = modelInBody.includes("deepseek") || modelInBody.includes("v4-flash");
        const isGlmModel = modelInBody.includes("glm");

        let out: any = body;
        if (isDeepseekModel) {
          out = transformThinkingModeBody(body);
        } else if (isGlmModel) {
          // For GLM models via opencode-go, use zai-style sanitization (reasoning backfill + tool shape).
          out = transformZaiThinkingBody(body);
        } else {
          // Other reasoning-capable models via Console Go (e.g. kimi-k2.7-code).
          // Verified 2026-07-02 (session 53f3c3ea4ae8): kimi histories arrive
          // MIXED — some assistant turns carry reasoning_content, some do not —
          // and Console Go rejects the request (400 "Upstream request failed").
          // Apply the same mixed-history reasoning backfill Z.ai uses.
          out = { ...body };
          if (Array.isArray(out.messages)) {
            out.messages = backfillReasoningContent(out.messages, { onlyIfMixed: true });
          }
        }

        // H3 REAL FIX — Console Go's upstream (kimi / deepseek / glm) rejects a
        // follow-up whose history has an assistant turn with a batch of parallel
        // tool_calls (observed 5/6 for kimi, up to 17 for glm). parallel_tool_calls
        // below is ignored by the model, so split any multi-tool-call assistant
        // turn into sequential single-call turns. No-op unless the failing
        // pattern is present, so successful requests are untouched.
        if (Array.isArray(out.messages)) {
          out.messages = splitParallelToolCalls(out.messages);
          // Repair empty/truncated tool_call arguments ("unexpected end of JSON
          // input" 1210 sub-cause) before they reach the Console Go upstream.
          out.messages = sanitizeToolCallArguments(out.messages);
        }

        // Additional sanitization for opencode-go (proxy can be sensitive):
        // Force no parallel to avoid large tool result batches causing upstream failures.
        // Drop null response_format.
        out.parallel_tool_calls = false;
        if ("response_format" in out) {
          const rf = out.response_format;
          if (rf == null || (typeof rf === "object" && Object.keys(rf).length === 0)) {
            delete out.response_format;
          }
        }
        return out;
      },
    });
    return (modelId: string) => {
      // Strip 'opencode/' prefix if present
      const cleanId = modelId.startsWith("opencode/") ? modelId.slice(9) : modelId;
      return p(cleanId);
    };
  }
}
