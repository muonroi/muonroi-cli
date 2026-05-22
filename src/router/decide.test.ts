import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels, getTestProviders } from "../__test-helpers__/catalog-fixtures.js";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { loadCatalog } from "../models/registry.js";
import { type DecideOpts, decide } from "./decide.js";
import { routerStore } from "./store.js";

// Mock bridge to always return null so tests go through HTTP path
vi.mock("../ee/bridge.js", () => ({
  routeModel: vi.fn().mockResolvedValue(null),
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  routeTask: vi.fn().mockResolvedValue(null),
}));

let BASE_OPTS: DecideOpts;

describe("decide()", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    await loadCatalog();
    const models = getTestModels();
    const providers = getTestProviders();
    BASE_OPTS = {
      tenantId: "default",
      cwd: "/tmp",
      defaultModel: models.balanced,
      defaultProvider: providers.default,
      threshold: 0.55,
    };
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
        model: "deepseek-v4-flash",
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
    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(result.tier).toBe("warm");
    expect(result.model).toBe("qwen2.5-coder");
    expect(routerStore.getState().lastDecision).toEqual(result);
  });

  it("falls through to cold when warm returns null", async () => {
    // Stub that returns null for warm but succeeds for cold.
    // Use defaultModel as cold-route model to avoid cap-driven downgrade for unknown models.
    const coldOnlyStub = await startStubEEServer({
      routeModel: undefined, // 500 -> null
      coldRoute: () => ({
        model: BASE_OPTS.defaultModel,
        tier: "cold" as const,
        reason: "ee-cold",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${coldOnlyStub.port}` }));

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(result.tier).toBe("cold");
    expect(result.model).toBe(BASE_OPTS.defaultModel);

    // Restore
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await coldOnlyStub.stop();
  });

  it("returns fallback when both warm and cold are unreachable", async () => {
    // Stub with no handlers -> both return 500 -> null
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(result.model).toBe(BASE_OPTS.defaultModel);
    expect(result.reason).toBe("fallback:ee-unreachable");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await deadStub.stop();
  });

  it("returns degraded tier in fallback when store.degraded is true", async () => {
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));
    routerStore.setState({ degraded: true });

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(result.tier).toBe("degraded");
    expect(result.reason).toBe("fallback:ee-unreachable");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await deadStub.stop();
  });
});

describe("provider constraint with PROVIDER_INHERIT", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    await loadCatalog();
  });

  afterAll(async () => {
    await stub?.stop();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    routerStore.setState({
      tier: "hot",
      degraded: false,
      lastDecision: null,
      lastHealthCheckAtMs: 0,
    });
  });

  it("constrains warm-path model when its provider is disabled", async () => {
    stub = await startStubEEServer({
      routeModel: () => ({
        model: "claude-sonnet-4-6",
        tier: "balanced" as const,
        confidence: 0.8,
        reason: "ee-warm",
        source: "brain",
        taskHash: "test-hash",
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));

    const settingsMod = await import("../utils/settings.js");
    vi.spyOn(settingsMod, "isProviderDisabled").mockImplementation((p) => p === "anthropic");

    const fallbackModel = getTestModels().fast;
    const fallbackProvider = getTestProviders().default;

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      {
        tenantId: "default",
        cwd: "/tmp",
        defaultModel: fallbackModel,
        defaultProvider: fallbackProvider,
        threshold: 0.55,
      },
    );

    expect(result.model).not.toBe("claude-sonnet-4-6");
    expect(result.reason).toContain("provider-constrained");
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
