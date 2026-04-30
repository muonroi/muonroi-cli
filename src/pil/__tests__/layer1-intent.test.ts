import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext } from '../types.js';

vi.mock('../../router/classifier/index.js', () => ({
  classify: vi.fn(),
}));

vi.mock('../ollama-classify.js', () => ({
  ollamaClassify: vi.fn().mockResolvedValue(null),
}));

import { layer1Intent } from '../layer1-intent.js';
import { classify } from '../../router/classifier/index.js';
import { ollamaClassify } from '../ollama-classify.js';

const mockClassify = vi.mocked(classify);
const mockOllamaClassify = vi.mocked(ollamaClassify);

const makeCtx = (raw = 'test prompt'): PipelineContext => ({
  raw,
  enriched: raw,
  taskType: null,
  domain: null,
  confidence: 0,
  outputStyle: null,
  tokenBudget: 500,
  metrics: null,
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

describe('layer1Intent — outputStyle detection', () => {
  it('coding task without detail or concise keywords → balanced', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('refactor this function'));
    expect(result.outputStyle).toBe('balanced');
  });

  it('coding task with "explain" keyword → detailed', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.75, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('explain why we should refactor this'));
    expect(result.outputStyle).toBe('detailed');
  });

  it('"teach me" triggers detailed style', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.8, reason: 'regex:edit' });
    const result = await layer1Intent(makeCtx('teach me how to edit this'));
    expect(result.outputStyle).toBe('detailed');
  });

  it('conversational turn (taskType=null) → outputStyle=null', async () => {
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.2, reason: 'low-confidence' });
    const result = await layer1Intent(makeCtx('hello how are you'));
    expect(result.outputStyle).toBeNull();
  });

  it('delta string includes style info for coding tasks', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('refactor this'));
    expect(result.layers[0].delta).toContain('style=balanced');
  });

  it('returns concise for terse indicators', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('just fix the bug quickly'));
    expect(result.outputStyle).toBe('concise');
  });

  it('returns balanced as default for normal coding prompts', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    const result = await layer1Intent(makeCtx('refactor the authentication module'));
    expect(result.outputStyle).toBe('balanced');
  });
});

describe('layer1Intent — Ollama fallback (Pass 3)', () => {
  beforeEach(() => {
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.2, reason: 'low-confidence' });
    mockOllamaClassify.mockResolvedValue(null);
  });

  it('Ollama called when classifier and keywords both miss', async () => {
    await layer1Intent(makeCtx('some ambiguous input without keywords'));
    expect(mockOllamaClassify).toHaveBeenCalledWith('some ambiguous input without keywords');
  });

  it('Ollama result used when it returns a taskType', async () => {
    mockOllamaClassify.mockResolvedValue({ taskType: 'plan', confidence: 0.55 });
    const result = await layer1Intent(makeCtx('some ambiguous input'));
    expect(result.taskType).toBe('plan');
    expect(result.confidence).toBe(0.55);
  });

  it('Ollama NOT called when classifier returns high confidence', async () => {
    mockClassify.mockReturnValue({ tier: 'hot', confidence: 0.85, reason: 'regex:refactor' });
    await layer1Intent(makeCtx('refactor this'));
    expect(mockOllamaClassify).not.toHaveBeenCalled();
  });

  it('Ollama NOT called when keyword match found', async () => {
    await layer1Intent(makeCtx('there is a bug here'));
    expect(mockOllamaClassify).not.toHaveBeenCalled();
  });

  it('Ollama returning null leaves taskType as null (fail-open)', async () => {
    mockOllamaClassify.mockResolvedValue(null);
    const result = await layer1Intent(makeCtx('some ambiguous input'));
    expect(result.taskType).toBeNull();
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
