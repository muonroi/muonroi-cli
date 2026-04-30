/**
 * Tests for src/providers/ollama.ts
 * Uses recorded JSONL fixture replayed via mocked streamText.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFixtureChunks, createMockFullStream } from './__test-utils__/load-fixture.js';
import type { StreamChunk } from './types.js';

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

import { streamText } from 'ai';
import { createOllamaAdapter } from './ollama.js';

const mockStreamText = vi.mocked(streamText);

describe('createOllamaAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has id "ollama"', () => {
    const adapter = createOllamaAdapter({ model: 'qwen2.5-coder:1.5b' });
    expect(adapter.id).toBe('ollama');
  });

  it('streams text-delta from ollama fixture', async () => {
    const chunks = loadFixtureChunks('ollama', 'streaming');
    mockStreamText.mockReturnValue({ fullStream: createMockFullStream(chunks) } as any);

    const adapter = createOllamaAdapter({ model: 'qwen2.5-coder:1.5b', baseURL: 'http://localhost:11434/api' });
    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      collected.push(chunk);
    }

    const textChunks = collected.filter((c) => c.kind === 'text-delta');
    expect(textChunks.length).toBeGreaterThanOrEqual(3);
    expect(collected.some((c) => c.kind === 'finish')).toBe(true);
  });
});
