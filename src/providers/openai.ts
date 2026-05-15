/**
 * src/providers/openai.ts
 *
 * OpenAI adapter implementation behind the Adapter interface.
 * Uses @ai-sdk/openai + AI SDK v6 streamText/fullStream.
 *
 * When oauthHeaders are provided (from loadTokensWithRefresh), the adapter
 * passes them as extraHeaders instead of using apiKey. The API-key path
 * continues to work unchanged when oauthHeaders is undefined.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { redactor } from "../utils/redactor.js";
import { streamFromFullStream } from "./stream-loop.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from "./types.js";

export interface OpenAIAdapterConfig extends ProviderConfig {
  /**
   * OAuth Bearer headers to use instead of apiKey.
   * When set, `apiKey` in ProviderConfig is ignored for auth.
   * Shape: { Authorization: "Bearer ey...", "ChatGPT-Account-ID": "..." }
   */
  oauthHeaders?: Record<string, string>;
}

/**
 * Create an OpenAI adapter.
 * Pass `oauthHeaders` for subscription-backed (Bearer) auth.
 * Pass `apiKey` for the traditional sk-... API key path.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): Adapter {
  if (config.apiKey && !config.oauthHeaders) {
    redactor.enrollSecret(config.apiKey);
  }

  // When using OAuth, supply a placeholder apiKey so the SDK does not reject
  // configuration validation. The real auth comes from extraHeaders.
  const provider = config.oauthHeaders
    ? createOpenAI({
        apiKey: "oauth", // placeholder — overridden by Authorization header
        headers: config.oauthHeaders,
      })
    : createOpenAI({ apiKey: config.apiKey });

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
