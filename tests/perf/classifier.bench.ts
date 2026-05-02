import { describe, it, expect, beforeAll } from 'vitest';
import { classify, warm } from '../../src/router/classifier/index.js';

describe('ROUTE-01 perf: warm p99 < threshold', () => {
  beforeAll(async () => {
    await warm();
    // Warm up JIT + module caches with throwaway calls
    for (let i = 0; i < 10; i++) classify('warmup prompt');
  }, 30_000);

  it('200 warm classify() samples', () => {
    const prompts = [
      'create a file foo.ts',
      '```ts\nconst x: number = 1;\n```',
      'edit src/index.ts to add a header',
      'explain what this code does',
      'refactor the auth module',
    ];
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      classify(prompts[i % prompts.length]);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    // CI environments and parallel test runs have higher variance
    const threshold = process.env.CI ? 50 : 10;
    expect(p99).toBeLessThan(threshold);
  });
});
