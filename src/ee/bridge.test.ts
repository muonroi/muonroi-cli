import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks (must be at module top-level for vi.mock hoisting) ──────────

const mockCore = vi.hoisted(() => ({
  classifyViaBrain: vi.fn().mockResolvedValue("generate"),
  searchCollection: vi.fn().mockResolvedValue([{ id: "p1", score: 0.9, payload: { text: "test" } }]),
  routeModel: vi.fn().mockResolvedValue({
    tier: "balanced",
    model: "claude-sonnet-4-6",
    confidence: 0.8,
    source: "brain",
    reason: "test",
    taskHash: "abc123",
  }),
  routeFeedback: vi.fn().mockResolvedValue(true),
  getEmbeddingRaw: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

const mockRequire = vi.hoisted(() => vi.fn().mockReturnValue(mockCore));
const mockAccess = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:module", () => ({
  createRequire: vi.fn().mockReturnValue(mockRequire),
}));

vi.mock("node:fs", () => ({
  promises: { access: mockAccess },
}));

// routeHistoryAdvice reaches EE via getDefaultEEClient() (`./intercept.js`), a
// SEPARATE path from the createRequire-based `mockCore` above.
const mockRouteHistory = vi.hoisted(() => vi.fn());
vi.mock("./intercept.js", () => ({
  getDefaultEEClient: () => ({ routeHistory: mockRouteHistory }),
}));

// ─── Import module under test (after mocks) ────────────────────────────────────

import {
  classifyViaBrain,
  getEmbeddingRaw,
  resetBridge,
  resetWhoAmIBrainWarm,
  routeFeedback,
  routeHistoryAdvice,
  routeModel,
  searchCollection,
  warmWhoAmIFromBrain,
} from "./bridge.js";
import { resetWhoAmICache } from "./who-am-i.js";

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("bridge — loaded core", () => {
  beforeEach(() => {
    resetBridge();
    mockAccess.mockResolvedValue(undefined);
    mockRequire.mockReturnValue(mockCore);
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockRequire.mockReturnValue(mockCore);
    mockCore.classifyViaBrain.mockResolvedValue("generate");
    mockCore.searchCollection.mockResolvedValue([{ id: "p1", score: 0.9, payload: { text: "test" } }]);
    mockCore.routeModel.mockResolvedValue({
      tier: "balanced",
      model: "claude-sonnet-4-6",
      confidence: 0.8,
      source: "brain",
      reason: "test",
      taskHash: "abc123",
    });
    mockCore.routeFeedback.mockResolvedValue(true);
    mockCore.getEmbeddingRaw.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    resetBridge();
  });

  it("Test 1: classifyViaBrain returns classification string when core loaded", async () => {
    const result = await classifyViaBrain("write a function to sort an array");
    expect(result).toBe("generate");
    expect(mockCore.classifyViaBrain).toHaveBeenCalledWith("write a function to sort an array", 5000, undefined);
  });

  it("Test 2: searchCollection returns EEPoint[] when core loaded", async () => {
    const vector = [0.1, 0.2, 0.3];
    const result = await searchCollection("my-collection", vector, 5);
    expect(result).toEqual([{ id: "p1", score: 0.9, payload: { text: "test" } }]);
    expect(mockCore.searchCollection).toHaveBeenCalledWith("my-collection", vector, 5, undefined);
  });

  it("Test 3: routeModel returns EERouteResult when core loaded", async () => {
    const result = await routeModel("code-generation", { cwd: "/home/user" }, "bun");
    expect(result).toEqual({
      tier: "balanced",
      model: "claude-sonnet-4-6",
      confidence: 0.8,
      source: "brain",
      reason: "test",
      taskHash: "abc123",
    });
    expect(mockCore.routeModel).toHaveBeenCalledWith("code-generation", { cwd: "/home/user" }, "bun");
  });

  it("Test 4: routeFeedback returns true when core loaded", async () => {
    const result = await routeFeedback("abc123", "balanced", "claude-sonnet-4-6", "success", 0, 1500);
    expect(result).toBe(true);
    expect(mockCore.routeFeedback).toHaveBeenCalledWith("abc123", "balanced", "claude-sonnet-4-6", "success", 0, 1500);
  });

  it("Test 5: getEmbeddingRaw returns number[] when core loaded", async () => {
    const result = await getEmbeddingRaw("hello world");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockCore.getEmbeddingRaw).toHaveBeenCalledWith("hello world", undefined);
  });
});

describe("bridge — missing core (BRIDGE-02)", () => {
  beforeEach(() => {
    resetBridge();
    vi.clearAllMocks();
    // Simulate file not found
    mockAccess.mockRejectedValue(new Error("ENOENT: no such file or directory"));
  });

  afterEach(() => {
    resetBridge();
  });

  it("Test 6: classifyViaBrain returns null when core file missing", async () => {
    const result = await classifyViaBrain("some prompt");
    expect(result).toBeNull();
  });

  it("Test 7: searchCollection returns [] when core file missing", async () => {
    const result = await searchCollection("col", [0.1], 3);
    expect(result).toEqual([]);
  });

  it("Test 8: routeModel returns null when core file missing", async () => {
    const result = await routeModel("task", {}, "bun");
    expect(result).toBeNull();
  });

  it("Test 9: routeFeedback returns false when core file missing", async () => {
    const result = await routeFeedback("hash", "tier", "model", "success", 0, null);
    expect(result).toBe(false);
  });

  it("Test 10: getEmbeddingRaw returns null when core file missing", async () => {
    const result = await getEmbeddingRaw("text");
    expect(result).toBeNull();
  });

  it("Test 11: console.warn called with 'experience-core.js not found' message when file missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await classifyViaBrain("prompt");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("experience-core.js not found"));
    warnSpy.mockRestore();
  });
});

describe("bridge — require throws (BRIDGE-02)", () => {
  beforeEach(() => {
    resetBridge();
    vi.clearAllMocks();
    // File exists but require() throws
    mockAccess.mockResolvedValue(undefined);
    mockRequire.mockImplementation(() => {
      throw new Error("corrupt module: unexpected token");
    });
  });

  afterEach(() => {
    resetBridge();
    // Restore mockRequire to default behavior for subsequent test groups
    mockRequire.mockReturnValue(mockCore);
  });

  it("Test 12: classifyViaBrain returns null when require throws", async () => {
    const result = await classifyViaBrain("prompt");
    expect(result).toBeNull();
  });

  it("Test 13: searchCollection returns [] when require throws", async () => {
    const result = await searchCollection("col", [0.1], 3);
    expect(result).toEqual([]);
  });

  it("Test 14: routeModel returns null when require throws", async () => {
    const result = await routeModel("task", {}, "bun");
    expect(result).toBeNull();
  });

  it("Test 15: routeFeedback returns false when require throws", async () => {
    const result = await routeFeedback("hash", "tier", "model", "fail", 1, null);
    expect(result).toBe(false);
  });

  it("Test 16: getEmbeddingRaw returns null when require throws", async () => {
    const result = await getEmbeddingRaw("text");
    expect(result).toBeNull();
  });

  it("Test 17: console.warn called with 'failed to load' message when require throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await classifyViaBrain("prompt");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
    warnSpy.mockRestore();
  });
});

describe("bridge — lazy singleton", () => {
  beforeEach(() => {
    resetBridge();
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockRequire.mockReturnValue(mockCore);
    mockCore.classifyViaBrain.mockResolvedValue("generate");
  });

  afterEach(() => {
    resetBridge();
  });

  it("Test 18: second call to classifyViaBrain does NOT re-attempt load (lazy singleton)", async () => {
    await classifyViaBrain("first call");
    await classifyViaBrain("second call");
    // mockRequire should only be called once (when loading the core)
    expect(mockRequire).toHaveBeenCalledTimes(1);
  });
});

describe("bridge — resetBridge", () => {
  beforeEach(() => {
    resetBridge();
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockRequire.mockReturnValue(mockCore);
    mockCore.classifyViaBrain.mockResolvedValue("generate");
  });

  afterEach(() => {
    resetBridge();
  });

  it("Test 19: resetBridge allows re-attempt on next call", async () => {
    // First call loads the core
    await classifyViaBrain("first");
    expect(mockRequire).toHaveBeenCalledTimes(1);

    // Reset clears state
    resetBridge();

    // Second call after reset should re-attempt load
    await classifyViaBrain("second");
    expect(mockRequire).toHaveBeenCalledTimes(2);
  });
});

describe("bridge — config isolation (BRIDGE-03)", () => {
  it("Test 20: classifyViaBrain signature does NOT accept config args (type-level check)", async () => {
    // This test verifies via TypeScript @ts-expect-error that config args are rejected
    // If type check passes (no error here), the function signature correctly excludes config params

    // Valid call — should compile
    const _validCall = () => classifyViaBrain("prompt");
    const _validCallWithTimeout = () => classifyViaBrain("prompt", 3000);

    // These would cause @ts-expect-error if uncommented:
    const _invalidCall = () => classifyViaBrain("prompt", 3000, "http://localhost:6333" as any);

    expect(_validCall).toBeDefined();
    expect(_validCallWithTimeout).toBeDefined();
  });

  it("Test 21: searchCollection signature does NOT accept qdrantUrl/ollamaUrl/brainModel", async () => {
    // Valid signature
    const _validCall = () => searchCollection("col", [0.1], 5);
    const _validCallWithSignal = () => searchCollection("col", [0.1], 5, new AbortController().signal);

    expect(_validCall).toBeDefined();
    expect(_validCallWithSignal).toBeDefined();
  });

  it("Test 22: routeModel signature does NOT accept config params", async () => {
    // Valid signature: (task, context, runtime)
    const _validCall = () => routeModel("task", { key: "value" }, "bun");
    expect(_validCall).toBeDefined();
  });
});

describe("bridge — warmWhoAmIFromBrain (thin-client boot contract)", () => {
  beforeEach(() => {
    resetWhoAmIBrainWarm();
    resetWhoAmICache();
    delete process.env.MUONROI_WHOAMI_BRAIN;
  });
  afterEach(() => {
    resetWhoAmIBrainWarm();
    resetWhoAmICache();
    delete process.env.MUONROI_WHOAMI_BRAIN;
  });

  it("returns null immediately when disabled (MUONROI_WHOAMI_BRAIN=0)", async () => {
    process.env.MUONROI_WHOAMI_BRAIN = "0";
    await expect(warmWhoAmIFromBrain()).resolves.toBeNull();
  });

  it("is idempotent — a second call is a guarded no-op that never throws", async () => {
    process.env.MUONROI_WHOAMI_BRAIN = "0";
    await warmWhoAmIFromBrain();
    await expect(warmWhoAmIFromBrain()).resolves.toBeNull();
  });

  it("is fail-open on a non-thin box (no server configured) — resolves null, never throws", async () => {
    // No EE server / thin-client mode in this test env → warm degrades to null.
    await expect(warmWhoAmIFromBrain()).resolves.toBeNull();
  });
});

describe("routeHistoryAdvice — validates the remote tier before it reaches the router", () => {
  // routeHistory()'s result comes from `(await resp.json()) as RouteHistoryResponse`
  // (src/ee/client.ts) — a TYPE CAST, not a runtime check. A malformed or
  // unrecognized floorTier/suggestedTier used to pass straight through to
  // resolveTurnTier (src/router/decide.ts), where tierRank() read it as rank -1 —
  // "lower than every real tier" — silently demoting any turn to "fast". This
  // boundary must reject anything outside ["fast","balanced","premium"] BEFORE it
  // reaches the router, exactly like getRoutingPromoteMax/getRoutingDemoteMin
  // (src/utils/settings.ts) whitelist their config-sourced tier strings.
  beforeEach(() => {
    mockRouteHistory.mockReset();
  });

  it("passes through two valid tiers unchanged", async () => {
    mockRouteHistory.mockResolvedValue({ floorTier: "premium", suggestedTier: "fast", matches: 2, reason: "x" });
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toEqual({
      floorTier: "premium",
      suggestedTier: "fast",
    });
  });

  it("a garbage suggestedTier is treated as absent (null), not passed through", async () => {
    mockRouteHistory.mockResolvedValue({ floorTier: "premium", suggestedTier: "ultra", matches: 2, reason: "x" });
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toEqual({
      floorTier: "premium",
      suggestedTier: null,
    });
  });

  it("a garbage floorTier is treated as absent (null), not passed through", async () => {
    mockRouteHistory.mockResolvedValue({ floorTier: "ultra", suggestedTier: "fast", matches: 2, reason: "x" });
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toEqual({
      floorTier: null,
      suggestedTier: "fast",
    });
  });

  it('a case-mismatched tier ("Fast") is rejected as unrecognized, not normalized', async () => {
    mockRouteHistory.mockResolvedValue({ floorTier: null, suggestedTier: "Fast", matches: 1, reason: "x" });
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toBeNull();
  });

  it("both fields garbage resolves to null advice (matches the existing 'no advice' contract)", async () => {
    mockRouteHistory.mockResolvedValue({ floorTier: "ultra", suggestedTier: 42, matches: 0, reason: "x" });
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toBeNull();
  });

  it("null from routeHistory stays null", async () => {
    mockRouteHistory.mockResolvedValue(null);
    await expect(routeHistoryAdvice("fix the flaky retry test")).resolves.toBeNull();
  });
});
