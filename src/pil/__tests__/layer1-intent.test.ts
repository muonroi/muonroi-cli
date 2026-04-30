import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext } from '../types.js';

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
  confidence: 0,
  layers: [],
});

beforeEach(() => { vi.clearAllMocks(); });

describe('layer1Intent — classifier pass', () => {
  it('regex:refactor → refactor, confidence stored', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('refactor this function'));
    expect(result.taskType).toBe('refactor');
    expect(result.confidence).toBe(0.85);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toContain('taskType=refactor');
    expect(result.layers[0].delta).toContain('conf=0.85');
  });

  it('regex:edit → generate', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'regex:edit' });
    const result = await layer1Intent(makeCtx('edit the file'));
    expect(result.taskType).toBe('generate');
  });

  it('regex:install → analyze', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:install' });
    const result = await layer1Intent(makeCtx('install the package'));
    expect(result.taskType).toBe('analyze');
    expect(result.layers[0].applied).toBe(true);
  });

  it('regex:run-command → analyze', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:run-command' });
    const result = await layer1Intent(makeCtx('run bun test'));
    expect(result.taskType).toBe('analyze');
  });

  it('tree-sitter:typescript → refactor, domain=typescript', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'tree-sitter:typescript' });
    const result = await layer1Intent(makeCtx('const x = 1'));
    expect(result.taskType).toBe('refactor');
    expect(result.domain).toBe('typescript');
    expect(result.layers[0].delta).toContain('domain=typescript');
  });

  it('tree-sitter:python → refactor, domain=python', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'tree-sitter:python' });
    const result = await layer1Intent(makeCtx('def foo(): pass'));
    expect(result.taskType).toBe('refactor');
    expect(result.domain).toBe('python');
  });

  it('low-confidence → null taskType, applied=false', async () => {
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.3, reason: 'low-confidence' });
    const result = await layer1Intent(makeCtx('hello there'));
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
  });

  it('regex:search → analyze', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'regex:search' });
    const result = await layer1Intent(makeCtx('search for the function'));
    expect(result.taskType).toBe('analyze');
  });
});

describe('layer1Intent — keyword fallback (classifier returns null)', () => {
  beforeEach(() => {
    // Simulate classifier abstain so keyword fallback activates
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.2, reason: 'low-confidence' });
  });

  it('keyword "bug" → debug', async () => {
    const result = await layer1Intent(makeCtx('there is a bug in the login flow'));
    expect(result.taskType).toBe('debug');
    expect(result.confidence).toBe(0.65);
    expect(result.layers[0].applied).toBe(true);
  });

  it('keyword "error" → debug', async () => {
    const result = await layer1Intent(makeCtx('getting an error on line 42'));
    expect(result.taskType).toBe('debug');
  });

  it('keyword "plan" → plan', async () => {
    const result = await layer1Intent(makeCtx('plan the refactor approach'));
    expect(result.taskType).toBe('plan');
    expect(result.confidence).toBe(0.60);
  });

  it('keyword "docs" → documentation', async () => {
    const result = await layer1Intent(makeCtx('write docs for this module'));
    expect(result.taskType).toBe('documentation');
    expect(result.confidence).toBe(0.60);
  });

  it('keyword "test" → analyze', async () => {
    const result = await layer1Intent(makeCtx('write tests for the auth module'));
    expect(result.taskType).toBe('analyze');
  });

  it('no keyword match → null (still conversational)', async () => {
    const result = await layer1Intent(makeCtx('hello how are you'));
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
  });
});

describe('layer1Intent — error handling', () => {
  it('classify throws → ctx unchanged, applied=false', async () => {
    mockClassify.mockImplementation(() => { throw new Error('classify failed'); });
    const ctx = makeCtx('some prompt');
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
