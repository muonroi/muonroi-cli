import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { callWarmRoute } from "./warm.js";

describe("callWarmRoute", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "qwen2.5-coder",
        provider: "ollama",
        tier: "warm" as const,
        confidence: 0.7,
        reason: "remote",
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
    expect(result!.provider).toBe("ollama");
    expect(result!.reason).toContain("warm:");
    expect(result!.confidence).toBe(0.7);
  });

  it("returns null when warm path times out (>250ms)", async () => {
    // Create a slow stub
    const slowStub = await startStubEEServer({
      latencyMs: 500,
      routeModel: () => ({
        model: "qwen2.5-coder",
        provider: "ollama",
        tier: "warm" as const,
        confidence: 0.7,
        reason: "remote",
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
