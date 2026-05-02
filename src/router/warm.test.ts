import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { callWarmRoute } from "./warm.js";

// ─── Bridge cascade tests ────────────────────────────────────────────────────

vi.mock("../ee/bridge.js", () => ({
  routeModel: vi.fn(),
}));

import { routeModel as bridgeRouteModel } from "../ee/bridge.js";
const mockBridgeRouteModel = vi.mocked(bridgeRouteModel);

describe("callWarmRoute bridge cascade", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "qwen2.5-coder",
        tier: "balanced" as const,
        confidence: 0.7,
        reason: "remote",
        source: "brain",
        taskHash: "http-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  afterEach(() => {
    mockBridgeRouteModel.mockReset();
  });

  it("returns bridge result without calling HTTP when bridge succeeds", async () => {
    mockBridgeRouteModel.mockResolvedValue({
      tier: "balanced",
      model: "deepseek-v3",
      reasoningEffort: "medium",
      confidence: 0.95,
      source: "brain",
      reason: "bridge-match",
      taskHash: "bridge-hash",
    });

    const result = await callWarmRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });

    expect(result).not.toBeNull();
    expect(result!.model).toBe("deepseek-v3");
    expect(result!.reason).toMatch(/^warm:bridge:/);
    expect(result!.confidence).toBe(0.95);
    expect(result!.taskHash).toBe("bridge-hash");
    expect(result!.source).toBe("brain");
    expect(result!.reasoningEffort).toBe("medium");
  });

  it("falls through to HTTP when bridge returns null", async () => {
    mockBridgeRouteModel.mockResolvedValue(null);

    const result = await callWarmRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });

    expect(result).not.toBeNull();
    expect(result!.model).toBe("qwen2.5-coder"); // HTTP stub model
    expect(result!.reason).toMatch(/^warm:/);
    expect(result!.reason).not.toMatch(/^warm:bridge:/);
    expect(result!.taskHash).toBe("http-hash");
  });

  it("maps bridge tier 'fast' to 'hot' and 'premium' to 'cold'", async () => {
    mockBridgeRouteModel.mockResolvedValue({
      tier: "fast",
      model: "gpt-4o-mini",
      confidence: 0.9,
      source: "brain",
      reason: "fast-task",
      taskHash: null,
    });

    const fast = await callWarmRoute("quick task", { tenantId: "default", cwd: "/tmp" });
    expect(fast!.tier).toBe("hot");

    mockBridgeRouteModel.mockResolvedValue({
      tier: "premium",
      model: "o1-pro",
      confidence: 0.85,
      source: "brain",
      reason: "complex-task",
      taskHash: null,
    });

    const premium = await callWarmRoute("complex analysis", { tenantId: "default", cwd: "/tmp" });
    expect(premium!.tier).toBe("cold");
  });
});

describe("callWarmRoute", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "qwen2.5-coder",
        tier: "balanced" as const,
        confidence: 0.7,
        reason: "remote",
        source: "brain",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  it("returns RouteDecision when stub responds successfully", async () => {
    const result = await callWarmRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("warm");
    expect(result!.model).toBe("qwen2.5-coder");
    expect(result!.provider).toBe("");
    expect(result!.reason).toContain("warm:");
    expect(result!.confidence).toBe(0.7);
  });

  it("returns null when warm path times out (>250ms)", async () => {
    // Create a slow stub
    const slowStub = await startStubEEServer({
      latencyMs: 500,
      routeModel: () => ({
        model: "qwen2.5-coder",
        tier: "balanced" as const,
        confidence: 0.7,
        reason: "remote",
        source: "brain",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${slowStub.port}` }));

    const result = await callWarmRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });
    expect(result).toBeNull();

    // Restore original stub
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await slowStub.stop();
  });
});
