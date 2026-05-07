/**
 * src/providers/openai-compatible.ts
 *
 * OpenAI-compatible adapter for DeepSeek + SiliconFlow.
 * Both share the same adapter with different baseURLs.
 * Uses @ai-sdk/openai-compatible + AI SDK v6 streamText/fullStream.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { redactor } from "../utils/redactor.js";
import { OPENAI_COMPATIBLE_BASE_URLS as DEFAULT_BASE_URLS } from "./endpoints.js";
import { streamFromFullStream } from "./stream-loop.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from "./types.js";

/**
 * Create an OpenAI-compatible adapter (DeepSeek, SiliconFlow, xAI/Grok, or custom).
 * The `id` field on config determines the ProviderId.
 */
export function createOpenAICompatibleAdapter(config: ProviderConfig & { id: string }): Adapter {
  if (config.apiKey) {
    redactor.enrollSecret(config.apiKey);
  }

  const baseURL = config.baseURL ?? DEFAULT_BASE_URLS[config.id as keyof typeof DEFAULT_BASE_URLS];
  const provider = createOpenAICompatible({
    name: config.id,
    baseURL,
    apiKey: config.apiKey,
  });

  return {
    id: config.id as import("./types.js").ProviderId,
    async *stream(req: AdapterRequest): ProviderStream {
      const result = streamText({
        model: provider(config.model),
        messages: req.messages,
        tools: req.tools as any,
        toolChoice: req.toolChoice as any,
        abortSignal: req.abortSignal,
      });
      yield* streamFromFullStream(result.fullStream);
    },
  };
}
