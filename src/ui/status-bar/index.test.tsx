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
vi.mock("../../state/active-run.js", () => ({
  activeRunStore: {
    getState: () => ({ runId: null, flowDir: null, productSlug: null }),
    subscribe: () => () => {},
    clearActiveRun: () => {},
  },
}));

import type { SprintProgressSegment, StatusBarState } from "../../state/status-bar-store.js";
import { footerSegments, renderSprintSegment, renderStatusBar } from "./index.js";

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
  it.each(["fixed", "auto", "suggest"] as const)("shows the effective %s routing mode", (routing_mode) => {
    const json = JSON.stringify(renderStatusBar(makeState({ routing_mode })));
    expect(json).toContain("slot-routing-mode");
    expect(json).toContain(routing_mode[0].toUpperCase() + routing_mode.slice(1));
  });
  it("renders a row with data-testid status-bar", () => {
    const el = renderStatusBar(makeState({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })) as any;
    expect(el.props["data-testid"]).toBe("status-bar");
  });

  it("includes model, current-run usage and a single spend meter", () => {
    const el = renderStatusBar(makeState({ provider: "anthropic", model: "opus", in_tokens: 10, out_tokens: 5 }));
    const json = JSON.stringify(el);
    expect(json).toContain("slot-provider-model");
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

  it("retains identity, usage and spend when degraded", () => {
    const el = renderStatusBar(makeState({ degraded: true }));
    const json = JSON.stringify(el);
    expect(json).toContain("slot-provider-model");
    expect(json).toContain("slot-tokens");
    expect(json).toContain('"key":"usd"');
    expect(json).toContain("slot-degraded");
  });

  it("renders separators between slots", () => {
    const el = renderStatusBar(makeState());
    const json = JSON.stringify(el);
    expect(json).toContain(" · ");
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

describe("footer priorities", () => {
  const state = makeState({
    provider: "fixture-provider",
    model: "fixture-model",
    permission_mode: "yolo",
    routing_mode: "fixed",
    ctx_pct: 13,
    in_tokens: 5_200_000,
    cache_read_tokens: 2_700_000,
    out_tokens: 165400,
    session_usd: 2.89,
    compaction_summary: "8 cmp, 237.0K saved via fixture-helper ⚠ long session — consider /clear",
  });
  it("keeps context and cache distinct, including zero hits", () => {
    const parts = footerSegments({ ...state, cache_read_tokens: 0 }, 80).secondary;
    expect(parts.map((p) => p.text)).toEqual(["Context 13%", "Cache hit 0%"]);
  });
  it("hides auxiliary detail at 80 columns while retaining permission and degraded state", () => {
    const parts = footerSegments({ ...state, degraded: true }, 80);
    expect(parts.primary.map((p) => p.text)).toEqual(["DEGRADED", "Yolo"]);
    expect(parts.secondary.map((p) => p.id)).toEqual(["context", "cache"]);
  });
  it("condenses compaction without displaying its helper as the owner or duplicating spend", () => {
    const json = JSON.stringify(renderStatusBar(state, { width: 180, cwd: "D:/workspace" }));
    expect(json).toContain("Compact 8 · Long session");
    expect(json).not.toContain("fixture-helper");
    expect(json).not.toContain("consider /clear");
    expect(json.match(/session_usd/g)).toHaveLength(1);
    expect(json).not.toContain("$2.89"); // spend belongs to the one UsdMeter component
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
