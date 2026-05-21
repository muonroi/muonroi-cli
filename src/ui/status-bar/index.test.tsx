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
vi.mock("../state/active-run.js", () => ({
  activeRunStore: {
    getState: () => ({ runId: null, flowDir: null, productSlug: null }),
    subscribe: () => () => {},
    clearActiveRun: () => {},
  },
}));

import { renderSprintSegment, renderStatusBar } from "./index.js";
import type { SprintProgressSegment, StatusBarState } from "./store.js";

function makeState(overrides: Partial<StatusBarState> = {}): StatusBarState {
  return {
    provider: "",
    model: "",
    tier: "hot",
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    session_usd: 0,
    month_usd: 0,
    cap_usd: 0,
    current_pct: 0,
    degraded: false,
    routed_from: null,
    ee_status: "unknown",
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

  // B1: sprint progress segment tests
  it("hides sprint segment when sprint is undefined", () => {
    const el = renderStatusBar(makeState({ sprint: undefined }));
    expect(JSON.stringify(el)).not.toContain("slot-sprint");
  });

  it("shows sprint segment with correct text when sprint is present", () => {
    const sprint: SprintProgressSegment = {
      activeSprintNumber: 2,
      totalSprints: 5,
      completedStories: 3,
      totalStories: 8,
      overallPct: 37.5,
    };
    const el = renderStatusBar(makeState({ sprint }));
    const json = JSON.stringify(el);
    expect(json).toContain("slot-sprint");
    expect(json).toContain("Sprint 2/5");
    expect(json).toContain("3/8 stories");
    expect(json).toContain("37.5%");
  });
});

describe("renderSprintSegment", () => {
  it("formats the segment correctly", () => {
    const seg: SprintProgressSegment = {
      activeSprintNumber: 1,
      totalSprints: 3,
      completedStories: 0,
      totalStories: 4,
      overallPct: 0,
    };
    expect(renderSprintSegment(seg)).toBe("Sprint 1/3 · 0/4 stories · 0%");
  });

  it("formats with non-zero values", () => {
    const seg: SprintProgressSegment = {
      activeSprintNumber: 3,
      totalSprints: 3,
      completedStories: 4,
      totalStories: 4,
      overallPct: 100,
    };
    expect(renderSprintSegment(seg)).toBe("Sprint 3/3 · 4/4 stories · 100%");
  });

  it("handles decimal overallPct", () => {
    const seg: SprintProgressSegment = {
      activeSprintNumber: 2,
      totalSprints: 4,
      completedStories: 2,
      totalStories: 5,
      overallPct: 33.3,
    };
    expect(renderSprintSegment(seg)).toBe("Sprint 2/4 · 2/5 stories · 33.3%");
  });
});
