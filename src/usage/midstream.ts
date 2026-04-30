/**
 * src/usage/midstream.ts
 *
 * Mid-stream policy for USAGE-05.
 * In-flight stream finishes after threshold breach; next reservation refused.
 * Acceptable single-stream overshoot ~101%.
 *
 * Subscribes to threshold events: {level:100} sets refuseNext=true.
 */

import { subscribeThresholds } from './thresholds.js';

let _refuseNext = false;
let _capPct = 0;

// Subscribe once at module load
subscribeThresholds((ev) => {
  _capPct = ev.current_pct;
  if (ev.level === 100) _refuseNext = true;
});

export const midstreamPolicy = {
  /** Whether the next stream reservation should be refused. */
  refuseNext(): boolean {
    return _refuseNext;
  },

  /** Force refuse (called when downgrade chain exhausted). */
  forceRefuseNext(): void {
    _refuseNext = true;
  },

  /** Reset state — for tests and month rollover. */
  clear(): void {
    _refuseNext = false;
    _capPct = 0;
  },

  /** Current cap percentage from latest threshold event. */
  currentPct(): number {
    return _capPct;
  },

  /**
   * In-flight stream may finish — caller checks BEFORE starting a new stream.
   * Always returns true: once a stream is in-flight, it completes.
   */
  isStreamFinishAllowed(): boolean {
    return true;
  },
};
