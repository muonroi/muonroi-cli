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

globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai"];

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
      defaultModel: "deepseek-v4-flash", // stable, independent of getModelByTier order after Agy catalog updates
      defaultProvider: "google",
      threshold: 0.55,
    };
    stub = await startStubEEServer({
      routeModel: (_req) => ({
        model: "deepseek-ai/DeepSeek-V4-Flash",
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
    globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai"];
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
    // decide() picks from current catalog (Agy google models may be selected depending on tier calc)
    expect(result.model).toMatch(/gemini-/);
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
    // Promotion cap (default "balanced", defaultModel deepseek-v4-flash = fast tier)
    // clamps the EE cold-path premium pick (gemini-3.1-pro-high) DOWN to the
    // balanced tier on the same provider (gemini-3.5-flash-medium). This is
    // the cost-leak guard: routine tasks must not silently promote to premium.
    expect(result.model).toBe("gemini-3.5-flash-medium");
    expect(result.reason).toContain("promo-cap");

    // Restore
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await coldOnlyStub.stop();
  });

  it("returns fallback when both warm and cold are unreachable", async () => {
    globalThis.disabledProvidersList = [];
    // Stub with no handlers -> both return 500 -> null
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    // Model id depends on current catalog getModelByTier / routing (Agy google models affect first premium etc.)
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
    vi.spyOn(settingsMod, "getDefaultProvider").mockImplementation(() => "google");

    const fallbackModel = "gemini-1.5-flash"; // A fast google model
    const fallbackProvider = "google";

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

  it("promotion cap: clamps cold premium pick to balanced by default; 'any' opt-in allows premium", async () => {
    // Cold path returns a premium-tier model (gemini-3.1-pro-high on google).
    // defaultModel = deepseek-v4-flash (fast). With default cap "balanced", the
    // premium pick must clamp to a same-provider balanced model.
    // Reproduces the 89b34ce9a4e8 leak class: EE returned premium for a routine
    // task; without the cap every turn silently ran on pro.
    const coldPremium = await startStubEEServer({
      routeModel: undefined,
      coldRoute: () => ({
        model: "gemini-3.1-pro-high",
        tier: "premium" as const,
        reason: "ee-cold-premium",
        taskHash: "test-hash",
      }),
    });
    // google enabled so the cold pick survives constrainToProvider.
    globalThis.disabledProvidersList = ["siliconflow", "deepseek", "openai", "xai"];
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${coldPremium.port}` }));

    // Default cap = "balanced": premium → balanced clamp + reason tag.
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "balanced";
    const clamped = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(clamped.model).toBe("gemini-3.5-flash-medium"); // google balanced
    expect(clamped.reason).toContain("promo-cap");

    // Opt-in "any" restores legacy promotion — premium pick is honored as-is.
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "any";
    routerStore.setState({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 });
    const promoted = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(promoted.model).toBe("gemini-3.1-pro-high");
    expect(promoted.reason).not.toContain("promo-cap");

    // Opt-in "off": ceiling = default model tier (fast). No balanced on google
    // path is irrelevant — the clamp walks down to fast on the same provider.
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "off";
    routerStore.setState({ tier: "hot", degraded: false, lastDecision: null, lastHealthCheckAtMs: 0 });
    const floored = await decide("check và commit các file trong todo plan", BASE_OPTS);
    expect(floored.model).toBe("gemini-3.5-flash-high"); // google fast
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
    expect(changes.length).toBe(2); // No more notifications after unsub
  });
});
