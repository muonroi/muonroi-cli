/**
 * Subscribable router state atom (Zustand-like, zero deps).
 *
 * Holds current tier, degraded flag, and last routing decision.
 * Plan 06 status bar subscribes to this store.
 */
import type { RouteDecision, Tier } from './types.js';

export interface RouterState {
  tier: Tier;
  degraded: boolean;
  lastDecision: RouteDecision | null;
  lastHealthCheckAtMs: number;
}

type Listener = (s: RouterState) => void;

function makeStore() {
  let state: RouterState = {
    tier: 'hot',
    degraded: false,
    lastDecision: null,
    lastHealthCheckAtMs: 0,
  };
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState: (patch: Partial<RouterState>) => {
      state = { ...state, ...patch };
      for (const l of listeners) l(state);
    },
    subscribe: (fn: Listener) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const routerStore = makeStore();
