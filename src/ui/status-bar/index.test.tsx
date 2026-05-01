/**
 * index.test.tsx -- tests for StatusBar pure render function (renderStatusBar).
 * Uses renderStatusBar directly to avoid needing React hooks context in tests.
 */
import { describe, expect, it, vi } from "vitest";

// Mock upstream deps (same as store.test.ts)
vi.mock("../../router/store.js", () => ({
  routerStore: {
    getState: () => ({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
vi.mock("../../usage/thresholds.js", () => ({
  subscribeThresholds: () => () => {},
}));
vi.mock("../../usage/downgrade.js", () => ({
  subscribeDowngrade: () => () => {},
}));

import { renderStatusBar } from "./index.js";
import type { StatusBarState } from "./store.js";

function makeState(overrides: Partial<StatusBarState> = {}): StatusBarState {
  return {
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
    ...overrides,
  };
}

describe("StatusBar (renderStatusBar)", () => {
  it("renders a row with data-testid status-bar", () => {
    const el = renderStatusBar(makeState({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })) as any;
    expect(el.props["data-testid"]).toBe("status-bar");
  });

  it("includes slot-provider-model, tier badge, slot-tokens, usd meter slots", () => {
    const el = renderStatusBar(makeState({ provider: "anthropic", model: "opus", in_tokens: 10, out_tokens: 5 }));
    const json = JSON.stringify(el);
    expect(json).toContain("slot-provider-model");
    // TierBadge/UsdMeter are function components -- verify by key presence in children
    expect(json).toContain('"key":"tier"');
    expect(json).toContain("slot-tokens");
    expect(json).toContain('"key":"usd"');
  });

  it("shows degraded marker only when degraded=true", () => {
    const el1 = renderStatusBar(makeState({ degraded: false }));
    expect(JSON.stringify(el1)).not.toContain("slot-degraded");

    const el2 = renderStatusBar(makeState({ degraded: true }));
    expect(JSON.stringify(el2)).toContain("slot-degraded");
  });

  it("renders provider/model text correctly", () => {
    const el = renderStatusBar(makeState({ provider: "openai", model: "gpt-4o" }));
    expect(JSON.stringify(el)).toContain("openai/gpt-4o");
  });

  it("renders all 5 slots + degraded when degraded=true", () => {
    const el = renderStatusBar(makeState({ degraded: true }));
    const json = JSON.stringify(el);
    expect(json).toContain("slot-provider-model");
    expect(json).toContain('"key":"tier"');
    expect(json).toContain("slot-tokens");
    expect(json).toContain('"key":"usd"');
    expect(json).toContain("slot-degraded");
  });

  it("renders separators between slots", () => {
    const el = renderStatusBar(makeState());
    const json = JSON.stringify(el);
    // Should have ' | ' separators
    expect(json).toContain(" | ");
  });
});
