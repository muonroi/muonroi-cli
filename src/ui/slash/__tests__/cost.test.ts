import { describe, it, expect, beforeEach } from 'vitest';
import type { SlashContext } from '../registry.js';
import {
  statusBarStore,
  __resetStatusBarStoreForTests,
} from '../../status-bar/store.js';

// Import to trigger self-registration
import '../cost.js';

import { dispatchSlash } from '../registry.js';

const makeCtx = (): SlashContext => ({
  cwd: '/tmp',
  tenantId: 'local',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-20250514',
});

describe('handleCostSlash', () => {
  beforeEach(() => {
    __resetStatusBarStoreForTests();
  });

  it('returns formatted output with default (zeroed) store state', async () => {
    const result = await dispatchSlash('cost', [], makeCtx());
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Provider: (none)');
    expect(result).toContain('Model:    (none)');
    expect(result).toContain('Tier:     hot');
    expect(result).toContain('0 in / 0 out');
    expect(result).toContain('$0.0000');
    expect(result).toContain('$0.00');
    expect(result).toContain('0.0%');
  });

  it('returns formatted output with populated store state', async () => {
    statusBarStore.setState({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tier: 'hot',
      in_tokens: 5000,
      out_tokens: 1200,
      session_usd: 0.034,
      month_usd: 2.5,
      cap_usd: 15,
      current_pct: 16.7,
    });

    const result = await dispatchSlash('cost', [], makeCtx());
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Provider: anthropic');
    expect(result).toContain('Model:    claude-sonnet-4-20250514');
    expect(result).toContain('Tier:     hot');
    expect(result).toContain('5000 in / 1200 out');
    expect(result).toContain('Session:  $0.0340');
    expect(result).toContain('Month:    $2.5000 / $15.00 (16.7%)');
  });

  it('is synchronous — handleCostSlash returns a string, not a Promise', async () => {
    // Import the handler directly
    const { handleCostSlash } = await import('../cost.js');
    const result = handleCostSlash([], makeCtx());
    // If synchronous, result is a string (not a Promise)
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
  });
});
