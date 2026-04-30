/**
 * Tests for src/providers/gemini.ts
 * Uses recorded JSONL fixtures replayed via mocked streamText.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFixtureChunks, createMockFullStream } from '../../tests/fixtures/providers/load-fixture.js';
import type { StreamChunk } from './types.js';

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

import { streamText } from 'ai';
import { createGeminiAdapter } from './gemini.js';

const mockStreamText = vi.mocked(streamText);

describe('createGeminiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has id "google"', () => {
    const adapter = createGeminiAdapter({ model: 'gemini-2.5-flash', apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx' });
    expect(adapter.id).toBe('google');
  });

  it('handles single-tool fixture emitting exactly one tool-call', async () => {
    const chunks = loadFixtureChunks('gemini', 'single-tool');
    mockStreamText.mockReturnValue({ fullStream: createMockFullStream(chunks) } as any);

    const adapter = createGeminiAdapter({ model: 'gemini-2.5-flash', apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx' });
    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'search' }] })) {
      collected.push(chunk);
    }

    const toolCalls = collected.filter((c) => c.kind === 'tool-call');
    expect(toolCalls.length).toBe(1);
    expect((toolCalls[0] as any).toolName).toBe('search');
  });
});
