/**
 * src/providers/gemini.ts
 *
 * Gemini adapter implementation behind the Adapter interface.
 * Uses @ai-sdk/google + AI SDK v6 streamText/fullStream.
 */

import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { redactor } from '../utils/redactor.js';
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from './types.js';
import { streamFromFullStream } from './stream-loop.js';

/**
 * Create a Gemini (Google) adapter.
 */
export function createGeminiAdapter(config: ProviderConfig): Adapter {
  if (config.apiKey) {
    redactor.enrollSecret(config.apiKey);
  }

  const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });

  return {
    id: 'google',
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
