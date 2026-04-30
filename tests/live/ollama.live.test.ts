/**
 * tests/live/ollama.live.test.ts
 *
 * Live smoke test for Ollama provider (local or VPS).
 * Run with: PROV_LIVE=1 bunx vitest run tests/live/ollama.live.test.ts
 * (No API key required — Ollama is keyless. Requires Ollama running locally.)
 *
 * Skipped silently when PROV_LIVE not set (describe.skip).
 */
import { describe, it, expect } from 'vitest';
import { createAdapter } from '../../src/providers/adapter.js';
import type { StreamChunk } from '../../src/providers/types.js';

const RUN = process.env.PROV_LIVE === '1';
const dx = RUN ? describe : describe.skip;

dx('PROV-ollama live smoke', () => {
  it('streams a one-token reply for "Say hi" using qwen2.5-coder:1.5b', async () => {
    const adapter = createAdapter('ollama', {
      model: 'qwen2.5-coder:1.5b',
      baseURL: 'http://localhost:11434/api',
    });

    const collected: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      messages: [{ role: 'user', content: 'Say hi in one word.' }],
    })) {
      collected.push(chunk);
    }

    const textChunks = collected.filter((c) => c.kind === 'text-delta');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(collected.some((c) => c.kind === 'finish')).toBe(true);
  }, 30_000);
});
