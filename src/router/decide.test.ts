import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { type DecideOpts, decide } from "./decide.js";
import { routerStore } from "./store.js";

const BASE_OPTS: DecideOpts = {
  tenantId: "default",
  cwd: "/tmp",
  defaultModel: "claude-sonnet-4-20250514",
  defaultProvider: "anthropic",
  threshold: 0.55,
};

describe("decide()", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "qwen2.5-coder",
        tier: "balanced" as const,
        confidence: 0.7,
        reason: "ee-warm",
        source: "brain",
        taskHash: "test-hash",
      }),
      coldRoute: (_req) => ({
        model: "deepseek-v3",
        tier: "premium" as const,
        reason: "ee-cold",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  beforeEach(() => {
    routerStore.setState({
      tier: "hot",
      degraded: false,
      lastDecision: null,
      lastHealthCheckAtMs: 0,
    });
  });

  it("falls through to warm when classifier abstains (stub classifier always abstains)", async () => {
    const result = await decide("write a function", BASE_OPTS);
    expect(result.tier).toBe("warm");
    expect(result.model).toBe("qwen2.5-coder");
    expect(routerStore.getState().lastDecision).toEqual(result);
  });

  it("falls through to cold when warm returns null", async () => {
    // Stub that returns null for warm but succeeds for cold
    const coldOnlyStub = await startStubEEServer({
      routeModel: undefined, // 500 -> null
      coldRoute: () => ({
        model: "deepseek-v3",
        tier: "premium" as const,
        reason: "ee-cold",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${coldOnlyStub.port}` }));

    const result = await decide("write a function", BASE_OPTS);
    expect(result.tier).toBe("cold");
    expect(result.model).toBe("deepseek-v3");

    // Restore
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await coldOnlyStub.stop();
  });

  it("returns fallback when both warm and cold are unreachable", async () => {
    // Stub with no handlers -> both return 500 -> null
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));

    const result = await decide("write a function", BASE_OPTS);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.reason).toBe("fallback:ee-unreachable");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await deadStub.stop();
  });

  it("returns degraded tier in fallback when store.degraded is true", async () => {
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));
    routerStore.setState({ degraded: true });

    const result = await decide("write a function", BASE_OPTS);
    expect(result.tier).toBe("degraded");
    expect(result.reason).toBe("fallback:ee-unreachable");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await deadStub.stop();
  });
});

describe("routerStore", () => {
  it("exposes subscribe/getState/setState and emits on changes", () => {
    const changes: any[] = [];
    const unsub = routerStore.subscribe((s) => changes.push({ ...s }));

    routerStore.setState({ tier: "warm" });
    expect(changes.length).toBe(1);
    expect(changes[0].tier).toBe("warm");

    routerStore.setState({ tier: "cold" });
    expect(changes.length).toBe(2);
    expect(changes[1].tier).toBe("cold");

    unsub();
    routerStore.setState({ tier: "hot" });
    expect(changes.length).toBe(2); // No more notifications after unsub
  });
});
