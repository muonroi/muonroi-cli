import { describe, it, expect, beforeAll } from 'vitest';
import { classify, warm } from './index.js';

describe('classify orchestrator', () => {
  beforeAll(async () => {
    await warm();
  }, 30_000);

  it('returns abstain for generic greeting with low confidence', () => {
    const result = classify('hi');
    expect(result.tier).toBe('abstain');
    expect(result.confidence).toBeLessThan(0.55);
    expect(result.reason).toBe('low-confidence');
  });

  it('returns hot for regex-matchable prompts', () => {
    const result = classify('create a file called hello.ts');
    expect(result.tier).toBe('hot');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('threshold gating: prompt scoring 0.6 returns abstain when threshold is 0.8', () => {
    // "explain something" matches regex with ~0.70 confidence
    const result = classify('explain what this does', 0.8);
    expect(result.tier).toBe('abstain');
  });

  it('returns hot for tree-sitter-detectable code prompts', () => {
    const result = classify('```ts\nconst x: number = 1;\n```');
    expect(result.tier).toBe('hot');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });
});
