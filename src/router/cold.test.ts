import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { callColdRoute } from "./cold.js";
import { loadCatalog } from "../models/registry.js";

describe("callColdRoute", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    await loadCatalog();
    stub = await startStubEEServer({
      coldRoute: (_req) => ({
        model: "deepseek-v4-flash",
        tier: "premium" as const,
        reason: "fallback",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  it("returns RouteDecision when stub responds successfully", async () => {
    const result = await callColdRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("cold");
    expect(result!.model).toBe("deepseek-v4-flash");
    // provider is resolved by detectProviderForModel; catalog maps deepseek-v4-flash → provider: deepseek
    expect(result!.provider).toBe("deepseek");
    expect(result!.reason).toContain("cold:");
  });

  it("returns null when cold path times out (>1000ms)", async () => {
    const slowStub = await startStubEEServer({
      latencyMs: 1500,
      coldRoute: () => ({
        model: "deepseek-v4-flash",
        tier: "premium" as const,
        reason: "fallback",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${slowStub.port}` }));

    const result = await callColdRoute("write a function", {
      tenantId: "default",
      cwd: "/tmp",
    });
    expect(result).toBeNull();

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await slowStub.stop();
  });
});
