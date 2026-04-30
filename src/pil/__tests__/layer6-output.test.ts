import { describe, it, expect } from 'vitest';
import { layer6Output, applyPilSuffix } from '../layer6-output.js';
import type { PipelineContext, TaskType } from '../types.js';

const makeCtx = (taskType: TaskType | null = null): PipelineContext => ({
  raw: 'test prompt',
  enriched: 'test prompt',
  taskType,
  domain: null,
  confidence: 0,
  layers: [],
});

describe('applyPilSuffix — per-task-type suffixes', () => {
  const taskTypes: TaskType[] = ['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'];

  it.each(taskTypes)('appends correct OUTPUT RULES for taskType=%s', (tt) => {
    const ctx = makeCtx(tt);
    const result = applyPilSuffix('SYSTEM', ctx);
    expect(result).toContain('SYSTEM');
    expect(result).toContain(`OUTPUT RULES (${tt})`);
    expect(result.length).toBeGreaterThan('SYSTEM'.length);
  });

  it('each task type has a distinct suffix', () => {
    const suffixes = taskTypes.map(tt => applyPilSuffix('', makeCtx(tt)));
    const unique = new Set(suffixes);
    expect(unique.size).toBe(taskTypes.length);
  });

  it('returns system prompt unchanged when taskType is null', () => {
    const system = 'You are a helpful assistant.';
    expect(applyPilSuffix(system, makeCtx(null))).toBe(system);
  });
});

describe('layer6Output', () => {
  it('with taskType=debug — applied=true, delta contains suffix=debug', async () => {
    const result = await layer6Output(makeCtx('debug'));
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=debug/);
    expect(result.layers[0].delta).toMatch(/chars=\d+/);
  });

  it('with taskType=refactor — applied=true, delta contains suffix=refactor', async () => {
    const result = await layer6Output(makeCtx('refactor'));
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=refactor/);
  });

  it('with taskType=null — applied=false, delta=null', async () => {
    const result = await layer6Output(makeCtx(null));
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
  });

  it('enriched unchanged (Layer 6 modifies system prompt only)', async () => {
    const ctx = makeCtx('generate');
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
