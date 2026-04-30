/**
 * Tests for src/providers/openai-compatible.ts
 * Verifies DeepSeek + SiliconFlow share the OpenAI-compatible adapter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFixtureChunks, createMockFullStream } from '../../tests/fixtures/providers/load-fixture.js';
import type { StreamChunk } from './types.js';

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

import { streamText } from 'ai';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const mockStreamText = vi.mocked(streamText);

describe('createOpenAICompatibleAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets id to "deepseek" when configured as deepseek', () => {
    const adapter = createOpenAICompatibleAdapter({
      id: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx',
      baseURL: 'https://api.deepseek.com/v1',
    });
    expect(adapter.id).toBe('deepseek');
  });

  it('sets id to "siliconflow" when configured as siliconflow', () => {
    const adapter = createOpenAICompatibleAdapter({
      id: 'siliconflow',
      model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
      apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx',
    });
    expect(adapter.id).toBe('siliconflow');
  });

  it('streams text-delta events from deepseek fixture', async () => {
    const chunks = loadFixtureChunks('deepseek', 'streaming');
    mockStreamText.mockReturnValue({ fullStream: createMockFullStream(chunks) } as any);

    const adapter = createOpenAICompatibleAdapter({
      id: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx',
    });
    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      collected.push(chunk);
    }

    const textChunks = collected.filter((c) => c.kind === 'text-delta');
    expect(textChunks.length).toBeGreaterThanOrEqual(3);
  });
});
