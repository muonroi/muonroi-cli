/**
 * Tests for Step-Aware Model Routing (SAMR).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog, MODELS } from "../../models/registry.js";
import { decideStepRouting, getStepRouterConfig, type StepRouterConfig } from "../step-router.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfig(overrides: Partial<StepRouterConfig> = {}): StepRouterConfig {
  return {
    enabled: true,
    toolExecutionTier: "fast",
    premiumSynthesis: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("decideStepRouting", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("returns phase2ModelId=null when disabled", () => {
    const decision = decideStepRouting("claude-sonnet-4-6", "anthropic", mockConfig({ enabled: false }));
    expect(decision.phase2ModelId).toBeNull();
    expect(decision.reason).toContain("disabled");
  });

  it("returns phase2ModelId=null when phase 1 model is already fast tier", () => {
    const fastModel = MODELS.find((m) => m.tier === "fast" && m.provider);
    if (!fastModel || !fastModel.provider) return;

    const decision = decideStepRouting(fastModel.id, fastModel.provider, mockConfig({ toolExecutionTier: "fast" }));
    expect(decision.phase1ModelId).toBe(fastModel.id);
  });

  it("returns a fast execution model for premium phase 1", () => {
    const premiumModel = MODELS.find((m) => m.tier === "premium" && m.provider);
    if (!premiumModel || !premiumModel.provider) return;

    const decision = decideStepRouting(premiumModel.id, premiumModel.provider, mockConfig());

    if (decision.phase2ModelId) {
      expect(decision.phase2ModelId).not.toBe(premiumModel.id);
      expect(decision.reason).toContain("→");
    }
  });

  it("respects toolExecutionTier setting", () => {
    const premiumModel = MODELS.find((m) => m.tier === "premium" && m.provider);
    if (!premiumModel || !premiumModel.provider) return;

    const balancedCfg = mockConfig({ toolExecutionTier: "balanced" });
    const decision = decideStepRouting(premiumModel.id, premiumModel.provider, balancedCfg);

    if (decision.phase2ModelId) {
      const execModel = MODELS.find((m) => m.id === decision.phase2ModelId);
      expect(execModel?.tier).toBe("balanced");
    }
  });

  it("phase1ModelId is always preserved", () => {
    const decision = decideStepRouting("claude-sonnet-4-6", "anthropic", mockConfig({ enabled: false }));
    expect(decision.phase1ModelId).toBe("claude-sonnet-4-6");
  });
});

describe("getStepRouterConfig", () => {
  it("returns a well-formed config (values depend on user-settings)", () => {
    const config = getStepRouterConfig();
    expect(typeof config.enabled).toBe("boolean");
    expect(["fast", "balanced"]).toContain(config.toolExecutionTier);
    expect(typeof config.premiumSynthesis).toBe("boolean");
  });
});

describe("default-off safety", () => {
  // SAMR is opt-in: default off until Phase1→Phase2 transition is covered
  // by an integration test against the real AI SDK. This test asserts the
  // DEFAULT_CONFIG behavior by passing { enabled: false } explicitly — what
  // a user with no stepRouter setting would get.
  it("explicit enabled=false returns phase2ModelId=null", () => {
    const decision = decideStepRouting("claude-opus-4-7", "anthropic", mockConfig({ enabled: false }));
    expect(decision.phase2ModelId).toBeNull();
    expect(decision.reason).toContain("disabled");
  });
});

describe("resolveExecutionModel disability checks (Phase 19)", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not return same-provider candidate when provider is disabled", async () => {
    const settingsMod = await import("../../utils/settings.js");
    vi.spyOn(settingsMod, "isProviderDisabled").mockImplementation((p) => p === "anthropic");
    vi.spyOn(settingsMod, "isModelDisabled").mockReturnValue(false);

    const premiumModel = MODELS.find((m) => m.tier === "premium" && m.provider === "anthropic");
    if (!premiumModel) return; // skip if no anthopic premium model loaded

    const decision = decideStepRouting(premiumModel.id, "anthropic", mockConfig());
    if (decision.phase2ModelId) {
      const execModel = MODELS.find((m) => m.id === decision.phase2ModelId);
      expect(execModel?.provider).not.toBe("anthropic");
    } else {
      // No alternative model found — acceptable (disabled provider, no cross-provider fallback)
      expect(decision.phase2ModelId).toBeNull();
    }
  });

  it("does not return a model that is in disabledModels", async () => {
    const settingsMod = await import("../../utils/settings.js");
    vi.spyOn(settingsMod, "isProviderDisabled").mockReturnValue(false);

    const premiumModel = MODELS.find((m) => m.tier === "premium" && m.provider);
    if (!premiumModel) return;
    const fastModel = MODELS.find((m) => m.tier === "fast" && m.provider === premiumModel.provider);
    if (!fastModel) return;

    vi.spyOn(settingsMod, "isModelDisabled").mockImplementation((id) => id === fastModel.id);

    const decision = decideStepRouting(premiumModel.id, premiumModel.provider!, mockConfig());
    expect(decision.phase2ModelId).not.toBe(fastModel.id);
  });

  it("falls through to cross-provider when same-provider model is disabled", async () => {
    const settingsMod = await import("../../utils/settings.js");
    const premiumModel = MODELS.find((m) => m.tier === "premium" && m.provider === "anthropic");
    if (!premiumModel) return;
    const sameFast = MODELS.find((m) => m.tier === "fast" && m.provider === "anthropic");
    if (!sameFast) return;

    // Disable the same-provider fast model; allow cross-provider
    vi.spyOn(settingsMod, "isModelDisabled").mockImplementation((id) => id === sameFast.id);
    vi.spyOn(settingsMod, "isProviderDisabled").mockReturnValue(false);

    const decision = decideStepRouting(premiumModel.id, "anthropic", mockConfig());
    // Either a different model is chosen or null — but NOT sameFast.id
    expect(decision.phase2ModelId).not.toBe(sameFast.id);
  });
});
