/**
 * src/providers/adapter.ts
 *
 * Registry/factory for getting an Adapter by ProviderId + ProviderConfig.
 * Central entry point for multi-provider streaming.
 */

import type { Adapter, ProviderConfig, ProviderId } from './types.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAIAdapter } from './openai.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';
import { createOllamaAdapter } from './ollama.js';

/**
 * Create an Adapter for the given provider.
 */
export function createAdapter(id: ProviderId, config: ProviderConfig): Adapter {
  switch (id) {
    case 'anthropic':
      return createAnthropicAdapter(config);
    case 'openai':
      return createOpenAIAdapter(config);
    case 'google':
      return createGeminiAdapter(config);
    case 'deepseek':
      return createOpenAICompatibleAdapter({ ...config, id: 'deepseek' });
    case 'siliconflow':
      return createOpenAICompatibleAdapter({ ...config, id: 'siliconflow' });
    case 'ollama':
      return createOllamaAdapter(config);
  }
}

/**
 * All supported provider IDs in priority order.
 */
export const ALL_PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'siliconflow',
  'ollama',
];
