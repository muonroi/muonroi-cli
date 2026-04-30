import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashContext } from '../registry.js';
import type { PipelineContext } from '../../../pil/index.js';

// Mock the PIL module before importing optimize
vi.mock('../../../pil/index.js', () => {
  return {
    getPilLastResult: vi.fn(),
    runPipeline: vi.fn(),
  };
});

import { getPilLastResult, runPipeline } from '../../../pil/index.js';

// Import to trigger self-registration
import '../optimize.js';

import { dispatchSlash } from '../registry.js';

const makeCtx = (): SlashContext => ({
  cwd: '/tmp',
  tenantId: 'local',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-20250514',
});

const makePipelineContext = (): PipelineContext => ({
  raw: 'fix this bug',
  enriched: 'Please fix this bug in the code.',
  taskType: 'debug',
  domain: 'typescript',
  layers: [
    { name: 'layer1-task-detect', applied: true, delta: '+task_type=debug' },
    { name: 'layer2-domain-inject', applied: true, delta: '+domain=typescript' },
    { name: 'layer3-context-compress', applied: false, delta: null },
    { name: 'layer4-principle-inject', applied: true, delta: '+2 principles' },
    { name: 'layer5-constraint-inject', applied: false, delta: null },
    { name: 'layer6-output-format', applied: true, delta: '+output_format' },
  ],
});

describe('handleOptimizeSlash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 1: no-arg form with populated store returns Enriched prompt header', async () => {
    const ctx = makePipelineContext();
    vi.mocked(getPilLastResult).mockReturnValue(ctx);

    const result = await dispatchSlash('optimize', [], makeCtx());
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Enriched prompt:');
  });

  it('Test 2: no-arg form with populated store returns 6 layer rows', async () => {
    const ctx = makePipelineContext();
    vi.mocked(getPilLastResult).mockReturnValue(ctx);

    const result = await dispatchSlash('optimize', [], makeCtx());
    expect(result).toBeTypeOf('string');

    // Count layer rows: each layer appears as a line with padded name
    const lines = (result as string).split('\n');
    const layerLines = lines.filter((l) => l.includes('applied=yes') || l.includes('applied=no'));
    expect(layerLines).toHaveLength(6);
  });

  it('Test 3: no-arg form with empty store returns help message containing no prompt processed yet', async () => {
    vi.mocked(getPilLastResult).mockReturnValue(null);

    const result = await dispatchSlash('optimize', [], makeCtx());
    expect(result).toBeTypeOf('string');
    expect((result as string).toLowerCase()).toContain('no prompt processed yet');
  });

  it('Test 4: arg form runs runPipeline on given string and returns layer table', async () => {
    const ctx = makePipelineContext();
    vi.mocked(runPipeline).mockResolvedValue(ctx);

    const result = await dispatchSlash('optimize', ['fix', 'this', 'bug'], makeCtx());
    expect(runPipeline).toHaveBeenCalledWith('fix this bug');
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Layer breakdown:');
  });

  it('Test 5: layer table row format has name padded to 28 chars and applied=yes/no', async () => {
    const ctx = makePipelineContext();
    vi.mocked(getPilLastResult).mockReturnValue(ctx);

    const result = await dispatchSlash('optimize', [], makeCtx()) as string;
    const lines = result.split('\n');
    const layerLines = lines.filter((l) => l.includes('applied=yes') || l.includes('applied=no'));

    // Each line starts with 2 spaces then name padded to 28 chars
    for (const line of layerLines) {
      // Strip leading 2 spaces
      const content = line.slice(2);
      // First 28 chars should be name padded
      const namePart = content.slice(0, 28);
      expect(namePart).toHaveLength(28);
      // Should contain applied=yes or applied=no (with trailing space)
      expect(line).toMatch(/applied=(yes|no )/);
    }
  });

  it('Test 6: handler is async SlashHandler returning string (not void, not null)', async () => {
    const ctx = makePipelineContext();
    vi.mocked(getPilLastResult).mockReturnValue(ctx);

    const { handleOptimizeSlash } = await import('../optimize.js');
    const result = handleOptimizeSlash([], makeCtx());

    // Should return a Promise (async)
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(typeof resolved).toBe('string');
    expect(resolved).not.toBeNull();
  });
});
