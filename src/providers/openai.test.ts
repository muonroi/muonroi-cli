/**
 * Tests for src/providers/openai.ts
 * Uses recorded JSONL fixtures replayed via mocked streamText.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFixtureChunks, createMockFullStream } from '../../tests/fixtures/providers/load-fixture.js';
import type { StreamChunk } from './types.js';

// Mock ai module's streamText
vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

// Mock @ai-sdk/openai
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

import { streamText } from 'ai';
import { createOpenAIAdapter } from './openai.js';

const mockStreamText = vi.mocked(streamText);

describe('createOpenAIAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has id "openai"', () => {
    const adapter = createOpenAIAdapter({ model: 'gpt-4o', apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx' });
    expect(adapter.id).toBe('openai');
  });

  it('streams text-delta events from streaming fixture', async () => {
    const chunks = loadFixtureChunks('openai', 'streaming');
    mockStreamText.mockReturnValue({ fullStream: createMockFullStream(chunks) } as any);

    const adapter = createOpenAIAdapter({ model: 'gpt-4o', apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx' });
    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      collected.push(chunk);
    }

    const textChunks = collected.filter((c) => c.kind === 'text-delta');
    expect(textChunks.length).toBeGreaterThanOrEqual(3);
    expect(collected.some((c) => c.kind === 'finish')).toBe(true);
  });

  it('yields parallel tool-call events with distinct toolCallIds', async () => {
    const chunks = loadFixtureChunks('openai', 'parallel-tools');
    mockStreamText.mockReturnValue({ fullStream: createMockFullStream(chunks) } as any);

    const adapter = createOpenAIAdapter({ model: 'gpt-4o', apiKey: 'test-key-xxxxxxxxxxxxxxxxxxxx' });
    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'read files' }] })) {
      collected.push(chunk);
    }

    const toolCalls = collected.filter((c) => c.kind === 'tool-call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    // Distinct toolCallIds
    const ids = new Set(toolCalls.map((c) => (c as any).toolCallId));
    expect(ids.size).toBe(toolCalls.length);
  });
});
