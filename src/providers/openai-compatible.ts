/**
 * src/providers/openai-compatible.ts
 *
 * OpenAI-compatible adapter for DeepSeek + SiliconFlow.
 * Both share the same adapter with different baseURLs.
 * Uses @ai-sdk/openai-compatible + AI SDK v6 streamText/fullStream.
 */

import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { redactor } from '../utils/redactor.js';
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from './types.js';
import { streamFromFullStream } from './stream-loop.js';

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
};

/**
 * Create an OpenAI-compatible adapter (DeepSeek or SiliconFlow).
 * The `id` field on config determines the ProviderId.
 */
export function createOpenAICompatibleAdapter(
  config: ProviderConfig & { id: 'deepseek' | 'siliconflow' },
): Adapter {
  if (config.apiKey) {
    redactor.enrollSecret(config.apiKey);
  }

  const baseURL = config.baseURL ?? DEFAULT_BASE_URLS[config.id];
  const provider = createOpenAICompatible({
    name: config.id,
    baseURL,
    apiKey: config.apiKey,
  });

  return {
    id: config.id,
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
