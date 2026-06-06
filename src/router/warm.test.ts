import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { getModelByTier, loadCatalog } from "../models/registry.js";
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
  });

  beforeEach(() => {
    // Re-pin the global EE client before each test so the second describe
    // block's beforeAll cannot leave a stale client pointing at a different port.
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
      model: "deepseek-v4-flash",
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
    expect(result!.model).toBe("deepseek-v4-flash");
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

  it("derives the EE runtime from the session provider (not hardcoded 'claude')", async () => {
    mockBridgeRouteModel.mockResolvedValue({
      tier: "balanced",
      model: "gpt-5.3-codex",
      confidence: 0.9,
      source: "brain",
      reason: "x",
      taskHash: null,
    });

    await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "openai" });
    expect(mockBridgeRouteModel.mock.calls.at(-1)?.[2]).toBe("codex");

    await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "google" });
    expect(mockBridgeRouteModel.mock.calls.at(-1)?.[2]).toBe("gemini");

    await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "anthropic" });
    expect(mockBridgeRouteModel.mock.calls.at(-1)?.[2]).toBe("claude");

    // Providers without an EE runtime ladder pass "" so EE returns tier only.
    await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "deepseek" });
    expect(mockBridgeRouteModel.mock.calls.at(-1)?.[2]).toBe("");
  });

  it("emits PROVIDER_INHERIT on the bridge path so constrainToProvider governs", async () => {
    mockBridgeRouteModel.mockResolvedValue({
      tier: "balanced",
      model: "gpt-5.3-codex",
      confidence: 0.9,
      source: "brain",
      reason: "x",
      taskHash: null,
    });
    const result = await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "openai" });
    expect(result!.provider).toBe(""); // PROVIDER_INHERIT
  });

  it("falls back to the catalog model when EE returns a null model (no EE runtime)", async () => {
    await loadCatalog();
    const fastDeepseek = getModelByTier("fast", "deepseek");
    // Skip gracefully if the test catalog has no deepseek-fast entry.
    if (!fastDeepseek) return;
    mockBridgeRouteModel.mockResolvedValue({
      // EE returns the tier but a null model for a runtime it cannot resolve.
      tier: "fast",
      model: null as unknown as string,
      confidence: 0.8,
      source: "keyword",
      reason: "fast complexity",
      taskHash: null,
    });
    const result = await callWarmRoute("t", { tenantId: "default", cwd: "/tmp", defaultProvider: "deepseek" });
    expect(result).not.toBeNull();
    expect(result!.model).toBe(fastDeepseek.id);
    expect(result!.provider).toBe(""); // still PROVIDER_INHERIT
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
  });

  beforeEach(() => {
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
