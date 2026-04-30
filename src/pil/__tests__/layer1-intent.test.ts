import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext } from '../types.js';

// Mock the classifier before importing layer1-intent
vi.mock('../../router/classifier/index.js', () => ({
  classify: vi.fn(),
}));

import { layer1Intent } from '../layer1-intent.js';
import { classify } from '../../router/classifier/index.js';

const mockClassify = vi.mocked(classify);

const makeCtx = (raw = 'test prompt'): PipelineContext => ({
  raw,
  enriched: raw,
  taskType: null,
  domain: null,
  layers: [],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('layer1Intent', () => {
  it('maps regex:refactor reason to taskType=refactor, applied=true', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const ctx = makeCtx('refactor this function');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBe('refactor');
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].name).toBe('intent-detection');
  });

  it('maps regex:edit reason to taskType=debug, applied=true', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'regex:edit' });
    const ctx = makeCtx('edit the file');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBe('debug');
    expect(result.layers[0].applied).toBe(true);
  });

  it('maps regex:create-file reason to taskType=generate, applied=true', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:create-file' });
    const ctx = makeCtx('create a new file');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBe('generate');
    expect(result.layers[0].applied).toBe(true);
  });

  it('maps tree-sitter:typescript reason to taskType=refactor, applied=true', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.75, reason: 'tree-sitter:typescript' });
    const ctx = makeCtx('some typescript code');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBe('refactor');
    expect(result.layers[0].applied).toBe(true);
  });

  it('maps low-confidence reason to taskType=null, applied=false', async () => {
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.3, reason: 'low-confidence' });
    const ctx = makeCtx('hello');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
  });

  it('maps regex:search reason to taskType=analyze, applied=true', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'regex:search' });
    const ctx = makeCtx('search for the function');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBe('analyze');
    expect(result.layers[0].applied).toBe(true);
  });

  it('layer1Intent throws internally — returns ctx with applied=false, original ctx unchanged', async () => {
    mockClassify.mockImplementation(() => { throw new Error('classify failed'); });
    const ctx = makeCtx('some prompt');
    const result = await layer1Intent(ctx);
    // ctx should be unchanged (taskType still null from original)
    expect(result.taskType).toBeNull();
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].name).toBe('intent-detection');
    // enriched unchanged
    expect(result.enriched).toBe(ctx.enriched);
  });
});
