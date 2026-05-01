/**
 * store.test.ts -- tests for statusBarStore + wireStatusBar subscriptions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture subscription callbacks so we can fire them in tests
let routerCallback: ((s: any) => void) | null = null;
let thresholdCallback: ((e: any) => void) | null = null;
let downgradeCallback: ((e: any) => void) | null = null;

vi.mock("../../router/store.js", () => ({
  routerStore: {
    getState: () => ({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 }),
    setState: () => {},
    subscribe: (fn: (s: any) => void) => {
      routerCallback = fn;
      return () => {
        routerCallback = null;
      };
    },
  },
}));

vi.mock("../../usage/thresholds.js", () => ({
  subscribeThresholds: (fn: (e: any) => void) => {
    thresholdCallback = fn;
    return () => {
      thresholdCallback = null;
    };
  },
}));

vi.mock("../../usage/downgrade.js", () => ({
  subscribeDowngrade: (fn: (e: any) => void) => {
    downgradeCallback = fn;
    return () => {
      downgradeCallback = null;
    };
  },
}));

import { __resetStatusBarStoreForTests, statusBarStore, wireStatusBar } from "./store.js";

describe("statusBarStore", () => {
  beforeEach(() => {
    __resetStatusBarStoreForTests();
    routerCallback = null;
    thresholdCallback = null;
    downgradeCallback = null;
  });

  it("has correct default state", () => {
    const s = statusBarStore.getState();
    expect(s.model).toBe("");
    expect(s.provider).toBe("");
    expect(s.tier).toBe("hot");
    expect(s.in_tokens).toBe(0);
    expect(s.out_tokens).toBe(0);
    expect(s.session_usd).toBe(0);
    expect(s.month_usd).toBe(0);
    expect(s.degraded).toBe(false);
  });

  it("setState merges partial updates and notifies subscribers", () => {
    const spy = vi.fn();
    statusBarStore.subscribe(spy);
    statusBarStore.setState({ model: "test-model" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(statusBarStore.getState().model).toBe("test-model");
  });
});

describe("wireStatusBar", () => {
  beforeEach(() => {
    __resetStatusBarStoreForTests();
    routerCallback = null;
    thresholdCallback = null;
    downgradeCallback = null;
  });

  it("registers 3 subscriptions; routerStore tier change updates store", () => {
    const off = wireStatusBar();
    expect(routerCallback).toBeTruthy();
    expect(thresholdCallback).toBeTruthy();
    expect(downgradeCallback).toBeTruthy();

    // Fire router update
    routerCallback!({
      tier: "warm",
      degraded: true,
      lastDecision: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      lastHealthCheckAtMs: 1,
    });

    const s = statusBarStore.getState();
    expect(s.tier).toBe("warm");
    expect(s.degraded).toBe(true);
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-3-5-sonnet-latest");
    off();
  });

  it("threshold event updates session_usd and month_usd", () => {
    const off = wireStatusBar();
    thresholdCallback!({
      level: 80,
      current_pct: 80,
      current_usd: 12.5,
      cap_usd: 15,
      atMs: 1,
    });

    const s = statusBarStore.getState();
    expect(s.session_usd).toBe(12.5);
    expect(s.month_usd).toBe(12.5);
    off();
  });

  it("downgrade event updates model", () => {
    const off = wireStatusBar();
    downgradeCallback!({
      fromModel: "claude-3-opus-latest",
      toModel: "claude-3-5-sonnet-latest",
      pct: 80,
      atMs: 1,
    });

    expect(statusBarStore.getState().model).toBe("claude-3-5-sonnet-latest");
    off();
  });
});
