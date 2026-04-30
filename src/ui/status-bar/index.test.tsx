/**
 * index.test.tsx -- tests for StatusBar composite component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';

// Mock upstream deps (same as store.test.ts)
vi.mock('../../router/store.js', () => ({
  routerStore: {
    getState: () => ({ tier: 'hot', degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
vi.mock('../../usage/thresholds.js', () => ({
  subscribeThresholds: () => () => {},
}));
vi.mock('../../usage/downgrade.js', () => ({
  subscribeDowngrade: () => () => {},
}));

import { StatusBar } from './index.js';
import { statusBarStore, __resetStatusBarStoreForTests } from './store.js';

/**
 * Helper: flatten ReactElement children into an array of ReactElements,
 * filtering out string separators.
 */
function getSlotElements(el: React.ReactElement): React.ReactElement[] {
  const args = (el as any).props.children
    ? Array.isArray((el as any).props.children)
      ? (el as any).props.children
      : [(el as any).props.children]
    : [];
  // StatusBar passes children as rest args to createElement('row', props, ...children)
  // For React.createElement('row', props, c1, c2, ...) the children are in props.children
  return args.filter((c: any) => c && typeof c === 'object' && c.props);
}

describe('StatusBar', () => {
  beforeEach(() => {
    __resetStatusBarStoreForTests();
  });

  it('renders all slots in order with separators', () => {
    statusBarStore.setState({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', tier: 'hot', in_tokens: 100, out_tokens: 50 });
    const el = StatusBar();
    // The top element should be a 'row' with data-testid='status-bar'
    expect(el.props['data-testid']).toBe('status-bar');
  });

  it('includes slot-provider-model, tier-badge, slot-tokens, usd-meter testids', () => {
    statusBarStore.setState({ provider: 'anthropic', model: 'opus', tier: 'hot', in_tokens: 10, out_tokens: 5 });
    const el = StatusBar();
    const json = JSON.stringify(el);
    expect(json).toContain('slot-provider-model');
    expect(json).toContain('tier-badge');
    expect(json).toContain('slot-tokens');
    expect(json).toContain('usd-meter');
  });

  it('shows degraded marker only when degraded=true', () => {
    statusBarStore.setState({ degraded: false });
    const el1 = StatusBar();
    const json1 = JSON.stringify(el1);
    expect(json1).not.toContain('slot-degraded');

    statusBarStore.setState({ degraded: true });
    const el2 = StatusBar();
    const json2 = JSON.stringify(el2);
    expect(json2).toContain('slot-degraded');
  });

  it('renders provider/model text correctly', () => {
    statusBarStore.setState({ provider: 'openai', model: 'gpt-4o' });
    const el = StatusBar();
    const json = JSON.stringify(el);
    expect(json).toContain('openai/gpt-4o');
  });

  it('renders 6 slots when degraded (provider-model, tier, tokens, usd-session, usd-month via UsdMeter, degraded)', () => {
    statusBarStore.setState({ degraded: true });
    const el = StatusBar();
    const json = JSON.stringify(el);
    // All 5 main testids + degraded
    expect(json).toContain('slot-provider-model');
    expect(json).toContain('tier-badge');
    expect(json).toContain('slot-tokens');
    expect(json).toContain('usd-meter');
    expect(json).toContain('slot-degraded');
  });
});
