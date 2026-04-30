/**
 * tests/live/openai.live.test.ts
 *
 * Live smoke test for OpenAI provider.
 * Run with: PROV_LIVE=1 OPENAI_API_KEY=... bunx vitest run tests/live/openai.live.test.ts
 *
 * Skipped silently when env not set (describe.skip).
 */
import { describe, it, expect } from 'vitest';
import { createAdapter } from '../../src/providers/adapter.js';
import type { StreamChunk } from '../../src/providers/types.js';

const RUN = process.env.PROV_LIVE === '1' && !!process.env.OPENAI_API_KEY;
const dx = RUN ? describe : describe.skip;

dx('PROV-openai live smoke', () => {
  it('streams a one-token reply for "Say hi" using gpt-4o-mini', async () => {
    const adapter = createAdapter('openai', {
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
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
