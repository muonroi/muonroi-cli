import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { midstreamPolicy } from './midstream.js';
import { emit } from './thresholds.js';
import type { ThresholdEvent } from './types.js';

describe('midstreamPolicy', () => {
  beforeEach(() => {
    midstreamPolicy.clear();
  });

  it('refuseNext() is false initially', () => {
    expect(midstreamPolicy.refuseNext()).toBe(false);
  });

  it('refuseNext() flips to true after {level:100} threshold event', () => {
    const ev: ThresholdEvent = {
      level: 100,
      current_pct: 100,
      current_usd: 15,
      cap_usd: 15,
      atMs: Date.now(),
    };
    emit(ev);
    expect(midstreamPolicy.refuseNext()).toBe(true);
  });

  it('does NOT flip on {level:50} or {level:80}', () => {
    emit({ level: 50, current_pct: 50, current_usd: 7.5, cap_usd: 15, atMs: Date.now() });
    expect(midstreamPolicy.refuseNext()).toBe(false);

    emit({ level: 80, current_pct: 80, current_usd: 12, cap_usd: 15, atMs: Date.now() });
    expect(midstreamPolicy.refuseNext()).toBe(false);
  });

  it('isStreamFinishAllowed() always returns true (in-flight finishes)', () => {
    expect(midstreamPolicy.isStreamFinishAllowed()).toBe(true);
    // Even after 100% breach
    emit({ level: 100, current_pct: 101, current_usd: 15.15, cap_usd: 15, atMs: Date.now() });
    expect(midstreamPolicy.isStreamFinishAllowed()).toBe(true);
  });

  it('currentPct() tracks the latest threshold event pct', () => {
    expect(midstreamPolicy.currentPct()).toBe(0);
    emit({ level: 50, current_pct: 52.3, current_usd: 7.8, cap_usd: 15, atMs: Date.now() });
    expect(midstreamPolicy.currentPct()).toBeCloseTo(52.3);
  });

  it('clear() resets state (for tests + month rollover)', () => {
    midstreamPolicy.forceRefuseNext();
    expect(midstreamPolicy.refuseNext()).toBe(true);
    midstreamPolicy.clear();
    expect(midstreamPolicy.refuseNext()).toBe(false);
    expect(midstreamPolicy.currentPct()).toBe(0);
  });
});
