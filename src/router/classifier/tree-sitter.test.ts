import { describe, it, expect, beforeAll } from 'vitest';
import { lazyTreeSitter, initTreeSitter } from './tree-sitter.js';

describe('tree-sitter classifier', () => {
  beforeAll(async () => {
    await initTreeSitter(['typescript', 'python']);
  }, 30_000);

  it('parses TypeScript fenced code with confidence >= 0.55', () => {
    const result = lazyTreeSitter('```ts\nconst x: number = 1\n```');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.reason).toMatch(/^tree-sitter:typescript/);
  });

  it('parses Python fenced code with confidence >= 0.55', () => {
    const result = lazyTreeSitter('```python\ndef f(x): return x\n```');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.reason).toMatch(/^tree-sitter:python/);
  });

  it('returns abstain for prompts without fenced code', () => {
    const result = lazyTreeSitter('hello world no code here');
    expect(result.tier).toBe('abstain');
    expect(result.reason).toBe('tree-sitter:no-fenced-code');
  });
});
