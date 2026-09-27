import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels, getTestProviders } from "../__test-helpers__/catalog-fixtures.js";
import { type StubHandle, startStubEEServer } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { loadCatalog } from "../models/registry.js";
import { clearRouteCache, type DecideOpts, decide, reportRouteOutcome } from "./decide.js";
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
    getRoutingDemoteMin: () => (globalThis as { routingDemoteMin?: string }).routingDemoteMin ?? "fast",
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
      recentFailures: 0,
    });
  });

  it("serves the session default when nothing classifies the turn, without calling EE", async () => {
    // EE's /api/route-model answered in ~4.8s against the old 250ms warm budget and
    // /api/cold-route never existed, so the ladder no longer waits on either.
    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(result.tier).toBe("hot");
    expect(result.model).toBe("glm-4.7");
    expect(result.reason).toBe("default");
    expect(result.taskHash).toMatch(/^[0-9a-f]{16}$/);
    expect(routerStore.getState().lastDecision).toEqual(result);
  });

  it("serves the default when EE is unreachable", async () => {
    globalThis.disabledProvidersList = [];
    const deadStub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${deadStub.port}` }));

    const result = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      BASE_OPTS,
    );
    expect(typeof result.model).toBe("string");
    expect(result.reason).toBe("default");

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
    expect(result.reason).toBe("default");

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

  it("promotion cap: clamps a premium pick to balanced by default; 'any' opt-in allows premium", async () => {
    globalThis.disabledProvidersList = ["deepseek", "openai", "xai"];
    const opts = {
      ...BASE_OPTS,
      pil: { domain: null, taskType: "plan", confidence: 0.75, gsdPhase: null } as DecideOpts["pil"],
    };

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "balanced";
    clearRouteCache();
    const clamped = await decide("design the billing ledger schema", opts);
    expect(clamped.model).toBe("glm-4.7");
    expect(clamped.reason).toContain("promo-cap");

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "any";
    clearRouteCache();
    const promoted = await decide("design the billing ledger schema", opts);
    expect(promoted.model).toBe("glm-5.2");
    expect(promoted.reason).not.toContain("promo-cap");

    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "off";
    clearRouteCache();
    const floored = await decide("design the billing ledger schema", opts);
    expect(floored.model).toBe("glm-4.7");
    expect(floored.reason).toContain("promo-cap");
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

    // Same cached decision; each prompt still gets its own taskHash for feedback.
    expect({ ...b, taskHash: undefined }).toEqual({ ...a, taskHash: undefined });
    expect(b.taskHash).not.toBe(a.taskHash);
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
    clearRouteCache();
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

  it("keeps the session model when the catalog has no routable cheaper tier", async () => {
    // documentation maps to "fast", but every zai fast model is tier_routing:false,
    // so "fast" on zai resolves to glm-4.7 itself.
    const d = await decide("viết docs cho module này", {
      ...BASE_OPTS,
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
      pil: pilFor("documentation"),
    });

    expect(d.model).toBe("glm-4.7");
  });
});

describe("tier evidence: bounded demotion, route history, escalation", () => {
  // openai resolves each tier to a distinct model: fast gpt-5.4-mini,
  // balanced gpt-5.4, premium gpt-5.5.
  const pilFor = (taskType: string) =>
    ({ domain: null, taskType, confidence: 0.75, gsdPhase: null }) as DecideOpts["pil"];
  const openai = (extra: Partial<DecideOpts> = {}): DecideOpts => ({
    ...BASE_OPTS,
    defaultModel: "gpt-5.4",
    defaultProvider: "openai",
    ...extra,
  });

  beforeEach(() => {
    globalThis.disabledProvidersList = [];
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "any";
    (globalThis as { routingDemoteMin?: string }).routingDemoteMin = "fast";
    routerStore.setState({ recentFailures: 0 });
    clearRouteCache();
  });

  it("demotes a documentation turn below the session model down to routingDemoteMin", async () => {
    const d = await decide("write docs for the ledger module", openai({ pil: pilFor("documentation") }));
    expect(d.model).toBe("gpt-5.4-mini");
  });

  it("routingDemoteMin=off keeps the session model as the floor", async () => {
    (globalThis as { routingDemoteMin?: string }).routingDemoteMin = "off";
    const d = await decide("write docs for the ledger module", openai({ pil: pilFor("documentation") }));
    expect(d.model).toBe("gpt-5.4");
    expect(d.reason).toContain("demote-floor");
  });

  it("route history can move a turn down to a tier that succeeded before", async () => {
    const d = await decide(
      "fix the flaky retry test",
      openai({ pil: pilFor("debug"), history: { floorTier: null, suggestedTier: "fast" } }),
    );
    expect(d.model).toBe("gpt-5.4-mini");
    expect(d.reason).toContain("history-down");
  });

  it("route history raises a turn above a tier similar tasks failed on", async () => {
    const d = await decide(
      "fix the flaky retry test",
      openai({ pil: pilFor("debug"), history: { floorTier: "premium", suggestedTier: null } }),
    );
    expect(d.model).toBe("gpt-5.5");
    expect(d.reason).toContain("history-floor");
  });

  it("a failed previous turn escalates the next decision one tier", async () => {
    reportRouteOutcome("h-prev", "fail", 1000);
    expect(routerStore.getState().recentFailures).toBe(1);
    const d = await decide("fix the flaky retry test", openai({ pil: pilFor("debug") }));
    expect(d.model).toBe("gpt-5.5");
    expect(d.reason).toContain("escalate:prev-fail");
    reportRouteOutcome(d.taskHash as string, "success", 1000);
    expect(routerStore.getState().recentFailures).toBe(0);
  });

  it("evidence moves the tier even when no classifier spoke", async () => {
    const d = await decide(
      "I need to analyze and restructure the payment processing module with proper error boundaries and retry logic across multiple services",
      openai({ history: { floorTier: "premium", suggestedTier: null } }),
    );
    expect(d.model).toBe("gpt-5.5");
    expect(d.source).toBe("evidence");
  });

  it("the promotion cap never cuts a turn below the session model's own tier", async () => {
    // Live log: `pil:general→premium | promo-cap(premium→balanced)` served a premium
    // session a balanced model. A cap below the session tier is not a ceiling on promotion.
    // anthropic: the session model claude-opus-5 is premium, while the premium tier
    // routes to claude-fable-5 — a different model at the SAME tier, as step-5-preview
    // and step-3.7-flash were in the log.
    (globalThis as { routingPromoteMax?: string }).routingPromoteMax = "balanced";
    const d = await decide(
      "design the billing ledger schema",
      openai({ defaultModel: "claude-opus-5", defaultProvider: "anthropic", pil: pilFor("plan") }),
    );
    expect(d.model).toBe("claude-fable-5");
    expect(d.reason).not.toContain("promo-cap");
  });

  it("records the task and the served catalog tier, and sends both with the outcome", async () => {
    const d = await decide("write docs for the ledger module", openai({ pil: pilFor("documentation") }));
    const state = routerStore.getState();
    expect(state.taskText).toBe("write docs for the ledger module");
    expect(state.eeTier).toBe("fast");
    expect(state.taskHash).toBe(d.taskHash);
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
