/**
 * Tests for src/providers/pricing.ts
 * Verifies lookupPricing returns correct USD/M for known (provider, model) pairs
 * and undefined for unknown models (except ollama wildcard).
 */
import { describe, it, expect } from 'vitest';
import { lookupPricing, PRICING } from './pricing.js';

describe('lookupPricing', () => {
  it('returns pricing for anthropic claude-3-5-sonnet-latest', () => {
    const p = lookupPricing('anthropic', 'claude-3-5-sonnet-latest');
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(3.00);
    expect(p!.output_per_million_usd).toBe(15.00);
  });

  it('returns pricing for openai gpt-4o', () => {
    const p = lookupPricing('openai', 'gpt-4o');
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(2.50);
    expect(p!.output_per_million_usd).toBe(10.00);
  });

  it('returns pricing for google gemini-2.5-flash', () => {
    const p = lookupPricing('google', 'gemini-2.5-flash');
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.30);
  });

  it('returns pricing for deepseek deepseek-chat', () => {
    const p = lookupPricing('deepseek', 'deepseek-chat');
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.27);
  });

  it('returns undefined for unknown provider', () => {
    expect(lookupPricing('nonexistent', 'model')).toBeUndefined();
  });

  it('returns undefined for unknown model on a known provider (not ollama)', () => {
    expect(lookupPricing('anthropic', 'nonexistent-model')).toBeUndefined();
  });

  it('returns zero pricing for any ollama model via wildcard', () => {
    const p = lookupPricing('ollama', 'any-model-here');
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0);
    expect(p!.output_per_million_usd).toBe(0);
  });

  it('PRICING map has entries for all 6 providers', () => {
    expect(Object.keys(PRICING)).toEqual(
      expect.arrayContaining(['anthropic', 'openai', 'google', 'deepseek', 'siliconflow', 'ollama'])
    );
  });
});
