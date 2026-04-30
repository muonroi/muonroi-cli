/**
 * src/providers/ollama.ts
 *
 * Ollama adapter implementation behind the Adapter interface.
 * Uses ollama-ai-provider-v2 + AI SDK v6 streamText/fullStream.
 * Ollama runs locally or on the VPS — no API key required by default.
 */

import { streamText } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from './types.js';
import { streamFromFullStream } from './stream-loop.js';

/**
 * Create an Ollama adapter.
 * baseURL defaults to http://localhost:11434/api if not provided.
 */
export function createOllamaAdapter(config: ProviderConfig): Adapter {
  const provider = createOllama({
    baseURL: config.baseURL ?? 'http://localhost:11434/api',
  });

  return {
    id: 'ollama',
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
