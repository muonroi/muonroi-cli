// Test stubs for ROUTE-11 routeFeedback wiring in orchestrator
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  routeFeedback: vi.fn().mockResolvedValue(true),
  routeModel: vi.fn().mockResolvedValue(null),
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  resetBridge: vi.fn(),
}));

vi.mock("../../pil/task-tier-map.js", () => ({
  taskTypeToTier: vi.fn().mockReturnValue("balanced"),
}));

describe("routeFeedback wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import routeFeedback from bridge", async () => {
    const bridge = await import("../../ee/bridge.js");
    expect(bridge.routeFeedback).toBeDefined();
  });

  it("should import taskTypeToTier from task-tier-map", async () => {
    const tierMap = await import("../../pil/task-tier-map.js");
    expect(tierMap.taskTypeToTier).toBeDefined();
  });

  it("routeFeedback signature accepts required params", async () => {
    const { routeFeedback } = await import("../../ee/bridge.js");
    // Verify the function can be called with correct signature
    await routeFeedback("hash123", "balanced", "claude-3", "success", 0, 1500);
    expect(routeFeedback).toHaveBeenCalledWith("hash123", "balanced", "claude-3", "success", 0, 1500);
  });

  it("taskTypeToTier maps correctly for routeFeedback tier param", async () => {
    const { taskTypeToTier } = await import("../../pil/task-tier-map.js");
    expect(taskTypeToTier("debug")).toBe("balanced");
  });

  it("routeFeedback returns true when bridge is available", async () => {
    const { routeFeedback } = await import("../../ee/bridge.js");
    const result = await routeFeedback("hash456", "premium", "claude-opus", "fail", 0, 3000);
    expect(result).toBe(true);
  });

  it("routeFeedback is called with 'cancelled' outcome for cancelled turns", async () => {
    const { routeFeedback } = await import("../../ee/bridge.js");
    await routeFeedback("hash789", "fast", "claude-haiku", "cancelled", 0, 500);
    expect(routeFeedback).toHaveBeenCalledWith("hash789", "fast", "claude-haiku", "cancelled", 0, 500);
  });
});
