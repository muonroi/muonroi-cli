import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels, getTestProviders } from "../__test-helpers__/catalog-fixtures.js";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { loadCatalog } from "../models/registry.js";
import { type DecideOpts, decide } from "./decide.js";
import { routerStore } from "./store.js";

declare global {
  var disabledProvidersList: string[];
}

// Mock bridge to always return null so tests go through HTTP path
vi.mock("../ee/bridge.js", () => ({
  routeModel: vi.fn().mockResolvedValue(null),
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  routeTask: vi.fn().mockResolvedValue(null),
}));

globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai", "google"];

vi.mock("../utils/settings.js", () => ({
  getRoleModel: () => undefined,
  getDefaultProvider: () => "anthropic",
  getRoutingPromoteMax: () => (globalThis as { routingPromoteMax?: string }).routingPromoteMax ?? "balanced",
  isCouncilMultiProviderPreferred: () => false,
  isProviderDisabled: (provider: string) => {
    const res = globalThis.disabledProvidersList.includes(provider);
    return res;
  },
}));

let BASE_OPTS: DecideOpts;

describe("decide()", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (url.toString().includes("catalog.muonroi.com")) {
        throw new Error("Network unreachable");
      }
      return originalFetch(url, init);
    });
    await loadCatalog();
    const _models = getTestModels();
    const _providers = getTestProviders();
    BASE_OPTS = {
      tenantId: "default",
      cwd: "/tmp",
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
      threshold: 0.55,
    };
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "deepseek-v4-flash",
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
    await stub?.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai", "google"];
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "balanced";
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
    expect(result.model).toMatch(/glm-/);
    expect(routerStore.getState().lastDecision).toEqual(result);
  });

  it("falls through to cold when warm returns null", async () => {
    const coldOnlyStub = await startStubEEServer({
      routeModel: undefined,
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
    expect(result.model).toBe("glm-4.7");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await coldOnlyStub.stop();
  });

  it("returns fallback when both warm and cold are unreachable", async () => {
    globalThis.disabledProvidersList = [];
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(typeof result.model).toBe("string");
    expect(result.reason).toBe("fallback:ee-unreachable");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await deadStub.stop();
  });

  it("returns degraded tier in fallback when store.degraded is true", async () => {
    globalThis.disabledProvidersList = [];
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
    vi.spyOn(settingsMod, "getDefaultProvider").mockImplementation(() => "zai");

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      {
        tenantId: "default",
        cwd: "/tmp",
        defaultModel: "glm-4.7",
        defaultProvider: "zai",
        threshold: 0.55,
      },
    );

    expect(result.model).not.toBe("claude-sonnet-4-6");
    expect(result.reason).toContain("provider-constrained");
  });

  it("promotion cap: clamps cold premium pick to balanced by default; 'any' opt-in allows premium", async () => {
    const coldPremium = await startStubEEServer({
      routeModel: undefined,
      coldRoute: () => ({
        model: "glm-5.2",
        tier: "premium" as const,
        reason: "ee-cold-premium",
        taskHash: "test-hash",
      }),
    });
    globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai", "google"];
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${coldPremium.port}` }));

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "balanced";
    const clamped = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(clamped.model).toBe("glm-4.7");
    expect(clamped.reason).toContain("promo-cap");

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "any";
    routerStore.setState({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 });
    const promoted = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(promoted.model).toBe("glm-5.2");
    expect(promoted.reason).not.toContain("promo-cap");

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "off";
    routerStore.setState({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 });
    const floored = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(floored.model).toBe("glm-4.7");
    expect(floored.reason).toContain("promo-cap");

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await coldPremium.stop();
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
    expect(changes.length).toBe(2);
  });
});
