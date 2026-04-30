/**
 * tier-badge.test.tsx -- tests for TierBadge component.
 */
import { describe, it, expect } from 'vitest';
import { TierBadge } from './tier-badge.js';

describe('TierBadge', () => {
  it('renders hot with green color', () => {
    const el = TierBadge({ tier: 'hot' }) as any;
    expect(el.props.color).toBe('green');
    expect(el.props.children).toBe('hot');
    expect(el.props['data-tier']).toBe('hot');
  });

  it('renders warm with cyan color', () => {
    const el = TierBadge({ tier: 'warm' }) as any;
    expect(el.props.color).toBe('cyan');
    expect(el.props.children).toBe('warm');
  });

  it('renders cold with magenta color', () => {
    const el = TierBadge({ tier: 'cold' }) as any;
    expect(el.props.color).toBe('magenta');
    expect(el.props.children).toBe('cold');
  });

  it('renders degraded with yellow and blink', () => {
    const el = TierBadge({ tier: 'degraded' }) as any;
    expect(el.props.color).toBe('yellow');
    expect(el.props.blink).toBe(true);
    expect(el.props.children).toBe('degraded');
  });

  it('does not blink for non-degraded tiers', () => {
    const el = TierBadge({ tier: 'hot' }) as any;
    expect(el.props.blink).toBeFalsy();
  });
});
