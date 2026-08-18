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

globalThis.disabledProvidersList = ["deepseek", "openai", "xai"];

vi.mock("../utils/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/settings.js")>();
  return {
    ...actual,
    getRoleModel: () => undefined,
    getDefaultProvider: () => "anthropic",
    getRoutingPromoteMax: () => (globalThis as { routingPromoteMax?: string }).routingPromoteMax ?? "balanced",
    isCouncilMultiProviderPreferred: () => false,
    isProviderDisabled: (provider: string) => globalThis.disabledProvidersList.includes(provider),
    getPeakHourPolicy: () => ({ enabled: false, mode: "downgrade" as const }),
  };
});

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
    globalThis.disabledProvidersList = ["deepseek", "openai", "xai"];
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
    globalThis.disabledProvidersList = ["deepseek", "openai", "xai"];
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

describe("route cache is scoped to the active model/provider", () => {
  // Session 3f998bfef7db (2026-07-27): the user hit a provider-side 400 on
  // gpt-5.4 and switched provider to escape it. interaction_logs then recorded
  //   id 286 @03:39:53 routing/default   default=gpt-5.4          → gpt-5.4
  //   id 293 @03:40:23 routing/promoted  default=deepseek-v4-flash → gpt-5.4
  //   id 392 @03:51:34 routing/promoted  default=deepseek-v4-flash → gpt-5.4
  // all three with the byte-identical reason "pil:debug(0.75)" — the signature
  // of a REPLAYED decision. routeCacheKey hashed only domain|taskType|gsdPhase,
  // so a decision computed under the old default was served after the switch and
  // sent the user straight back to the provider they had just abandoned.
  const pil = { domain: null, taskType: "debug", confidence: 0.75, gsdPhase: null } as DecideOpts["pil"];

  beforeEach(() => {
    globalThis.disabledProvidersList = [];
  });

  it("does not serve a decision cached under a different default model", async () => {
    const first = await decide("tiếp tục", { ...BASE_OPTS, defaultModel: "glm-4.7", defaultProvider: "zai", pil });
    const afterSwitch = await decide("tiếp tục nhé", {
      ...BASE_OPTS,
      defaultModel: "deepseek-v4-flash",
      defaultProvider: "deepseek",
      pil,
    });

    expect(first.model).not.toBe("deepseek-v4-flash");
    expect(afterSwitch.model).not.toBe(first.model);
  });

  it("still caches when the model and provider are unchanged", async () => {
    const opts = { ...BASE_OPTS, defaultModel: "glm-4.7", defaultProvider: "zai", pil };
    const a = await decide("tiếp tục", opts);
    const b = await decide("tiếp tục nhé", opts);

    expect(b).toEqual(a);
  });
});

describe("PIL step-0 uses the real taskType→tier map", () => {
  // `pilTier` was `opts.pil.taskType as "fast" | "balanced" | "premium"` — a cast
  // that can never hold: taskType values are debug/analyze/plan/…, so
  // matchesTier() never matched, getModelByTier returned undefined, and the whole
  // "PIL context override" branch fell through to opts.defaultModel. It only ever
  // populated the route cache. taskTypeToTier (src/pil/task-tier-map.ts) is the
  // canonical map — decide() already uses taskTypeToRole from the same module.
  const pilFor = (taskType: string) =>
    ({ domain: null, taskType, confidence: 0.75, gsdPhase: null }) as DecideOpts["pil"];

  beforeEach(() => {
    globalThis.disabledProvidersList = [];
  });

  it("names the RESOLVED tier in the reason, not the raw taskType", async () => {
    const d = await decide("fix the failing test", {
      ...BASE_OPTS,
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
      pil: pilFor("debug"),
    });

    expect(d.reason).toContain("balanced");
    expect(d.reason).not.toMatch(/pil:debug\(/);
  });

  it("promotes a premium-tier task above the user's balanced default", async () => {
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "premium";

    const d = await decide("design the billing ledger schema", {
      ...BASE_OPTS,
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
      pil: pilFor("plan"),
    });

    expect(d.model).toBe("glm-5.2");
  });

  it("never silently DOWNGRADES below the tier the user's chosen model sits at", async () => {
    // documentation maps to "fast"; the user deliberately picked a balanced
    // model. Undoing that pick is the same class of defect as the route-cache
    // replay above — PIL may raise the tier, never quietly lower it.
    const d = await decide("viết docs cho module này", {
      ...BASE_OPTS,
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
      pil: pilFor("documentation"),
    });

    expect(d.model).toBe("glm-4.7");
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
