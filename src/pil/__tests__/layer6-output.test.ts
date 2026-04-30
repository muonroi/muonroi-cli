import { describe, it, expect } from 'vitest';
import { layer6Output, applyPilSuffix } from '../layer6-output.js';
import type { PipelineContext } from '../types.js';

const makeCtx = (taskType: PipelineContext['taskType'] = null): PipelineContext => ({
  raw: 'test prompt',
  enriched: 'test prompt',
  taskType,
  domain: null,
  layers: [],
});

describe('applyPilSuffix', () => {
  it('appends OUTPUT_SUFFIX_CODING when taskType is refactor', () => {
    const ctx = makeCtx('refactor');
    const result = applyPilSuffix('You are a helpful assistant.', ctx);
    expect(result).toContain('You are a helpful assistant.');
    expect(result).toContain('OUTPUT RULES (strict)');
    expect(result.length).toBeGreaterThan('You are a helpful assistant.'.length);
  });

  it('returns system prompt unchanged when taskType is null', () => {
    const ctx = makeCtx(null);
    const system = 'You are a helpful assistant.';
    const result = applyPilSuffix(system, ctx);
    expect(result).toBe(system);
  });
});

describe('layer6Output', () => {
  it('with taskType=debug — enriched unchanged, delta=output-optimization-applied, applied=true', async () => {
    const ctx = makeCtx('debug');
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toBe('output-optimization-applied');
    expect(result.layers[0].name).toBe('output-optimization');
  });

  it('with taskType=null — applied=false, enriched unchanged', async () => {
    const ctx = makeCtx(null);
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
    expect(result.layers[0].name).toBe('output-optimization');
  });
});
