/**
 * src/usage/thresholds.ts
 *
 * Threshold event system for USAGE-02.
 * Fires at 50/80/100% of monthly cap crossing.
 * Events are deduplicated per month via thresholds_fired_this_month in UsageState.
 *
 * Plan 06 (status bar) and Plan 05 (downgrade chain) consume these events.
 */

import type { ThresholdEvent, ThresholdLevel } from "./types.js";

type Listener = (e: ThresholdEvent) => void;
const listeners = new Set<Listener>();

/**
 * Subscribe to threshold crossing events.
 * Returns an unsubscribe function.
 */
export function subscribeThresholds(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Emit a threshold event to all subscribers.
 * Called by ledger.ts commit() after lock release.
 */
export function emit(e: ThresholdEvent): void {
  for (const l of listeners) l(e);
}

const LEVELS: ThresholdLevel[] = [50, 80, 100];

export interface EvalArgs {
  prevUsd: number;
  nextUsd: number;
  capUsd: number;
  firedThisMonth: number[];
}

export interface EvalResult {
  events: ThresholdEvent[];
  nextFired: number[];
}

/**
 * Evaluate which threshold boundaries were crossed.
 * Returns events to emit and the updated fired-this-month array.
 * Pure function -- no side effects.
 */
export function evaluateThresholds(args: EvalArgs): EvalResult {
  const out: ThresholdEvent[] = [];
  const nextFired = [...args.firedThisMonth];

  for (const lv of LEVELS) {
    const boundary = (args.capUsd * lv) / 100;
    if (args.prevUsd < boundary && args.nextUsd >= boundary && !nextFired.includes(lv)) {
      const ev: ThresholdEvent = {
        level: lv,
        current_pct: (args.nextUsd / args.capUsd) * 100,
        current_usd: args.nextUsd,
        cap_usd: args.capUsd,
        atMs: Date.now(),
      };
      out.push(ev);
      nextFired.push(lv);
    }
  }

  return { events: out, nextFired };
}
