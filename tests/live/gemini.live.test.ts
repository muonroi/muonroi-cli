/**
 * tests/live/gemini.live.test.ts
 *
 * Live smoke test for Gemini provider.
 * Run with: PROV_LIVE=1 GOOGLE_API_KEY=... bunx vitest run tests/live/gemini.live.test.ts
 *
 * Skipped silently when env not set (describe.skip).
 */
import { describe, it, expect } from 'vitest';
import { createAdapter } from '../../src/providers/adapter.js';
import type { StreamChunk } from '../../src/providers/types.js';

const RUN = process.env.PROV_LIVE === '1' && !!process.env.GOOGLE_API_KEY;
const dx = RUN ? describe : describe.skip;

dx('PROV-gemini live smoke', () => {
  it('streams a one-token reply for "Say hi" using gemini-2.5-flash', async () => {
    const adapter = createAdapter('google', {
      apiKey: process.env.GOOGLE_API_KEY!,
      model: 'gemini-2.5-flash',
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
