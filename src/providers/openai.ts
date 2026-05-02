/**
 * src/providers/openai.ts
 *
 * OpenAI adapter implementation behind the Adapter interface.
 * Uses @ai-sdk/openai + AI SDK v6 streamText/fullStream.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { redactor } from "../utils/redactor.js";
import { streamFromFullStream } from "./stream-loop.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from "./types.js";

/**
 * Create an OpenAI adapter.
 */
export function createOpenAIAdapter(config: ProviderConfig): Adapter {
  if (config.apiKey) {
    redactor.enrollSecret(config.apiKey);
  }

  const provider = createOpenAI({ apiKey: config.apiKey });

  return {
    id: "openai",
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
