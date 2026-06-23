/**
 * src/providers/gemini.ts
 *
 * Gemini/Agy adapter implementation behind the Adapter interface.
 * Uses @ai-sdk/google + AI SDK v6 streamText/fullStream.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText } from "ai";
import { redactor } from "../utils/redactor.js";
import { streamFromFullStream } from "./stream-loop.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from "./types.js";

/**
 * Create a Gemini (Google) adapter.
 */
export function createGeminiAdapter(config: ProviderConfig): Adapter {
  if (config.apiKey && !config.oauthHeaders) {
    redactor.enrollSecret(config.apiKey);
  }

  // When OAuth headers are present, route auth through extraHeaders. The Gemini
  // SDK still wants a non-empty apiKey for config validation; the Authorization
  // header takes precedence on the wire.
  const provider = config.oauthHeaders
    ? createGoogleGenerativeAI({
        apiKey: "oauth",
        baseURL: config.baseURL,
        headers: config.oauthHeaders,
      })
    : createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });

  return {
    id: "google",
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
