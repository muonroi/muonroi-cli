import { describe, it, expect } from 'vitest';
import { PipelineContextSchema, TaskTypeSchema, OutputStyleSchema, PipelineMetricsSchema } from '../schema.js';

describe('PipelineContextSchema', () => {
  const validCtx = {
    raw: 'test',
    enriched: 'test',
    taskType: 'refactor' as const,
    domain: null,
    confidence: 0.85,
    outputStyle: 'concise' as const,
    tokenBudget: 500,
    metrics: null,
    layers: [{ name: 'intent-detection', applied: true, delta: 'taskType=refactor' }],
  };

  it('accepts valid PipelineContext', () => {
    const result = PipelineContextSchema.safeParse(validCtx);
    expect(result.success).toBe(true);
  });

  it('accepts null taskType and outputStyle', () => {
    const result = PipelineContextSchema.safeParse({
      ...validCtx,
      taskType: null,
      outputStyle: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence > 1', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects confidence < 0', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid taskType', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, taskType: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid outputStyle', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, outputStyle: 'verbose' });
    expect(result.success).toBe(false);
  });

  it('rejects tokenBudget <= 0', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, tokenBudget: 0 });
    expect(result.success).toBe(false);
  });

  it('safeParse never throws', () => {
    expect(() => PipelineContextSchema.safeParse(null)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse(undefined)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse(42)).not.toThrow();
    expect(() => PipelineContextSchema.safeParse('string')).not.toThrow();
  });

  it('accepts valid metrics object', () => {
    const result = PipelineContextSchema.safeParse({
      ...validCtx,
      metrics: { totalMs: 5, layerTimings: [{ name: 'l1', ms: 2 }], inputChars: 10, outputChars: 10, estimatedTokensSaved: 20, enrichmentTokensAdded: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null metrics', () => {
    const result = PipelineContextSchema.safeParse({ ...validCtx, metrics: null });
    expect(result.success).toBe(true);
  });
});

describe('PipelineMetricsSchema', () => {
  it('accepts valid metrics', () => {
    const result = PipelineMetricsSchema.safeParse({
      totalMs: 10, layerTimings: [], inputChars: 5, outputChars: 5, estimatedTokensSaved: 0, enrichmentTokensAdded: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative totalMs', () => {
    const result = PipelineMetricsSchema.safeParse({
      totalMs: -1, layerTimings: [], inputChars: 0, outputChars: 0, estimatedTokensSaved: 0, enrichmentTokensAdded: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('TaskTypeSchema', () => {
  it.each(['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'])('accepts %s', (t) => {
    expect(TaskTypeSchema.safeParse(t).success).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(TaskTypeSchema.safeParse('unknown').success).toBe(false);
  });
});

describe('OutputStyleSchema', () => {
  it.each(['concise', 'detailed', 'balanced'])('accepts %s', (s) => {
    expect(OutputStyleSchema.safeParse(s).success).toBe(true);
  });

  it('rejects unknown style', () => {
    expect(OutputStyleSchema.safeParse('verbose').success).toBe(false);
  });
});
