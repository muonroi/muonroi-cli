/**
 * src/ui/status-bar/store.ts
 *
 * Status bar store: subscribable atom holding model/provider/tier/tokens/USD/degraded.
 * wireStatusBar() connects to routerStore (Plan 03), subscribeThresholds (Plan 04),
 * and subscribeDowngrade (Plan 05).
 */

import { routerStore } from "../../router/store.js";
import { subscribeDowngrade } from "../../usage/downgrade.js";
import { subscribeThresholds } from "../../usage/thresholds.js";

export interface StatusBarState {
  provider: string;
  model: string;
  tier: "hot" | "warm" | "cold" | "degraded";
  in_tokens: number;
  out_tokens: number;
  session_usd: number;
  month_usd: number;
  cap_usd: number;
  current_pct: number;
  degraded: boolean;
}

type Listener = (s: StatusBarState) => void;

function makeStore() {
  let state: StatusBarState = {
    provider: "",
    model: "",
    tier: "hot",
    in_tokens: 0,
    out_tokens: 0,
    session_usd: 0,
    month_usd: 0,
    cap_usd: 0,
    current_pct: 0,
    degraded: false,
  };
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState: (p: Partial<StatusBarState>) => {
      state = { ...state, ...p };
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

export const statusBarStore = makeStore();

let wired = false;

/**
 * Wire status bar to upstream stores.
 * Returns an unsubscribe-all function.
 * Idempotent -- second call is a no-op until the returned cleanup runs.
 */
export function wireStatusBar(): () => void {
  if (wired) return () => {};
  wired = true;

  const offRouter = routerStore.subscribe((rs) => {
    statusBarStore.setState({
      tier: rs.tier,
      degraded: rs.degraded,
      provider: rs.lastDecision?.provider ?? statusBarStore.getState().provider,
      model: rs.lastDecision?.model ?? statusBarStore.getState().model,
    });
  });

  const offThresholds = subscribeThresholds((ev) => {
    statusBarStore.setState({
      session_usd: ev.current_usd,
      month_usd: ev.current_usd,
      cap_usd: ev.cap_usd,
      current_pct: ev.current_pct,
    });
  });

  const offDowngrade = subscribeDowngrade((ev) => {
    statusBarStore.setState({
      model: ev.toModel,
      current_pct: ev.pct,
    });
  });

  return () => {
    offRouter();
    offThresholds();
    offDowngrade();
    wired = false;
  };
}

/** Test helper: reset store to default state. */
export function __resetStatusBarStoreForTests(): void {
  statusBarStore.setState({
    provider: "",
    model: "",
    tier: "hot",
    in_tokens: 0,
    out_tokens: 0,
    session_usd: 0,
    month_usd: 0,
    cap_usd: 0,
    current_pct: 0,
    degraded: false,
  });
  wired = false;
}
