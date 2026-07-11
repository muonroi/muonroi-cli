import { beforeAll, describe, expect, test } from "vitest";
import { resolveModelForTask, type TierLookup } from "../../orchestrator/sub-agent-model-tier.js";
import {
  getCatalogCouncilRouting,
  getEffectiveReasoningEffort,
  getModelByTier,
  getModelIds,
  getModelInfo,
  getModelsForProvider,
  getProviderPeakHourRule,
  getSupportedReasoningEfforts,
  getVisionProxyRouting,
  getWebResearchModel,
  isReasoningModel,
  loadCatalog,
  MODELS,
  modelHasNativeWebResearch,
  normalizeModelId,
  SWITCH_PROVIDER_ORDER,
} from "../registry";

beforeAll(async () => {
  await loadCatalog();
});

describe("MODELS catalog", () => {
  test("has at least one model", () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  describe("Part E — native web research", () => {
    test("openai + xai + zai models are web-native; deepseek + opencode-go are not", () => {
      for (const m of MODELS) {
        const expected = m.provider === "openai" || m.provider === "xai" || m.provider === "zai";
        expect(modelHasNativeWebResearch(m.id)).toBe(expected);
      }
    });

    test("getWebResearchModel returns a web-native routable model", () => {
      const m = getWebResearchModel();
      expect(m).toBeDefined();
      expect(m!.nativeWebResearch).toBe(true);
    });

    test("getWebResearchModel honors a reachable-id constraint", () => {
      const webNative = MODELS.filter((m) => m.nativeWebResearch === true);
      const only = new Set([webNative[0]!.id]);
      expect(getWebResearchModel(only)?.id).toBe(webNative[0]!.id);
      // No web-native model reachable → undefined (drives degraded confidence).
      const deepseekOnly = new Set(MODELS.filter((m) => m.provider === "deepseek").map((m) => m.id));
      expect(getWebResearchModel(deepseekOnly)).toBeUndefined();
    });
  });

  test("every model has required fields", () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(typeof m.inputPrice).toBe("number");
      expect(typeof m.outputPrice).toBe("number");
      expect(typeof m.reasoning).toBe("boolean");
      expect(m.description).toBeTruthy();
    }
  });

  test("no duplicate IDs", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getModelIds", () => {
  test("returns array of all model IDs", () => {
    const ids = getModelIds();
    expect(ids.length).toBe(MODELS.length);
    expect(ids).toContain("deepseek-v4-flash");
  });
});

describe("getModelInfo", () => {
  test("returns info for known model", () => {
    const info = getModelInfo("deepseek-v4-flash");
    expect(info).toBeDefined();
    expect(info!.name).toBe("DeepSeek V4 Flash (native)");
    expect(info!.contextWindow).toBe(128_000);
  });

  test("returns info via alias", () => {
    const info = getModelInfo("deepseek-flash-native");
    expect(info).toBeDefined();
    expect(info!.id).toBe("deepseek-v4-flash");
  });

  test("returns undefined for unknown model", () => {
    expect(getModelInfo("nonexistent-model")).toBeUndefined();
  });

  test("resolves a dropped id via successor alias (grok-build-0.1)", () => {
    // grok-build-0.1 was dropped from the catalog (commit b50f1c60) in favor of
    // Composer 2.5; the alias keeps old sessions/configs resolvable to the right
    // provider instead of throwing "not found in catalog".
    const info = getModelInfo("grok-build-0.1");
    expect(info).toBeDefined();
    expect(info!.id).toBe("grok-composer-2.5-fast");
    expect(info!.provider).toBe("xai");
  });

  test("resolves a gateway-prefixed id by stripping the prefix", () => {
    // A router/persisted id may carry a gateway prefix the native API rejects
    // (e.g. "deepseek-ai/deepseek-v4-flash"). When the prefixed form is not a
    // catalog id/alias but the tail is, the tail resolves.
    const info = getModelInfo("deepseek-ai/deepseek-v4-flash");
    expect(info).toBeDefined();
    expect(info!.id).toBe("deepseek-v4-flash");
  });

  test("prefix fallback still returns undefined for a non-catalog tail", () => {
    expect(getModelInfo("some-gateway/totally-made-up")).toBeUndefined();
  });
});

describe("normalizeModelId", () => {
  test("resolves alias to canonical ID", () => {
    expect(normalizeModelId("deepseek-flash-native")).toBe("deepseek-v4-flash");
  });

  test("passes through unknown IDs unchanged", () => {
    expect(normalizeModelId("custom-model-123")).toBe("custom-model-123");
  });

  test("passes through canonical IDs unchanged", () => {
    expect(normalizeModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });
});

describe("getEffectiveReasoningEffort", () => {
  test("returns provided effort for reasoning model", () => {
    expect(getEffectiveReasoningEffort("deepseek-v4-flash", "high")).toBe("high");
  });

  test("returns undefined when no effort provided", () => {
    expect(getEffectiveReasoningEffort("deepseek-v4-flash", undefined)).toBeUndefined();
  });
});

describe("getSupportedReasoningEfforts", () => {
  test("returns efforts for reasoning-capable model", () => {
    const efforts = getSupportedReasoningEfforts("deepseek-v4-flash");
    expect(efforts.length).toBeGreaterThan(0);
  });
});

describe("isReasoningModel", () => {
  test("returns true for reasoning models", () => {
    const reasoning = MODELS.find((m) => m.reasoning);
    expect(reasoning).toBeDefined();
    expect(isReasoningModel(reasoning!.id)).toBe(true);
    // Also exercise alias resolution and known IDs if present in the loaded catalog.
    if (getModelInfo("deepseek-v4-flash")) {
      expect(isReasoningModel("deepseek-v4-flash")).toBe(true);
    }
  });

  test("returns false for non-reasoning models", () => {
    const nonReasoning = MODELS.find((m) => !m.reasoning);
    expect(nonReasoning).toBeDefined();
    expect(isReasoningModel(nonReasoning!.id)).toBe(false);
  });

  test("returns false for unknown model IDs", () => {
    expect(isReasoningModel("nonexistent-model")).toBe(false);
  });
});

describe("tier_routing catalog flag", () => {
  test("glm-4.7-flash is still addressable but excluded from tier routing", () => {
    const flash = getModelInfo("glm-4.7-flash");
    expect(flash).toBeDefined();
    expect(flash!.tierRouting).toBe(false);
    expect(getModelByTier("fast", "zai")?.id).not.toBe("glm-4.7-flash");
  });

  test("zai fast tier routes to glm-4.7 via routing_tiers (Coding Plan routine model)", () => {
    expect(getModelInfo("glm-4.7")?.tier).toBe("balanced");
    expect(getModelByTier("fast", "zai")?.id).toBe("glm-4.7");
    expect(getModelByTier("balanced", "zai")?.id).toBe("glm-4.7");
    const lookup = getModelByTier as TierLookup;
    expect(resolveModelForTask("compact", "zai", "glm-4.7", lookup, { parentTier: "balanced" })).toBe("glm-4.7");
  });

  test("zai premium routes to glm-5.2; glm-5v-turbo excluded from auto-routing", () => {
    expect(getModelByTier("premium", "zai")?.id).toBe("glm-5.2");
    expect(getModelInfo("glm-5v-turbo")?.tierRouting).toBe(false);
    expect(getModelInfo("glm-5.1")?.tierRouting).toBe(false);
    const lookup = getModelByTier as TierLookup;
    expect(resolveModelForTask("verify", "zai", "glm-5.2", lookup, { parentTier: "premium" })).toBe("glm-5.2");
  });

  test("deepseek-ai namespaced model ids are absent from catalog", () => {
    expect(getModelInfo("deepseek-ai/DeepSeek-V4-Flash")).toBeUndefined();
  });
});

describe("provider_policies from catalog", () => {
  test("loads switch provider order from routing", () => {
    expect(SWITCH_PROVIDER_ORDER).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });

  test("loads zai peak-hour rule from vendor-sourced catalog metadata", () => {
    const rule = getProviderPeakHourRule("zai");
    expect(rule).toBeDefined();
    expect(rule!.timezone).toBe("Asia/Shanghai");
    expect(rule!.start_hour).toBe(14);
    expect(rule!.end_hour).toBe(18);
    expect(rule!.sensitive_model_ids).toContain("glm-5.2");
    expect(rule!.fallback_model_id).toBe("glm-4.7");
    expect(rule!.source_url).toContain("docs.z.ai");
  });

  test("loads council multi-provider lineup from routing.council", () => {
    const council = getCatalogCouncilRouting();
    expect(council?.prefer_multi_provider).toBe(true);
    expect(council?.participants).toHaveLength(3);
    const implement = council?.participants?.find((p) => p.role === "implement");
    expect(implement?.provider).toBe("deepseek");
    expect(implement?.model_id).toBe("deepseek-v4-flash");
    const verify = council?.participants?.find((p) => p.role === "verify");
    expect(verify?.provider).toBe("zai");
    expect(verify?.model_id).toBe("glm-5.2");
    const research = council?.participants?.find((p) => p.role === "research");
    expect(research?.provider).toBe("opencode-go");
  });

  test("loads vision_proxy routing for text-only model backend", () => {
    const vp = getVisionProxyRouting();
    expect(vp?.default?.provider).toBe("zai");
    expect(vp?.default?.model_id).toBe("glm-4.6v-flash");
    expect(vp?.ocr?.model_id).toBe("glm-4.6v-flash");
    expect(vp?.design?.model_id).toBe("glm-5.2");
    expect(vp?.fallback_chain?.length).toBeGreaterThanOrEqual(1);
    expect(vp?.fallback_chain?.[0]?.provider).toBe("xai");
  });

  test("loads deepseek official dual peak windows from vendor announcement", () => {
    const rule = getProviderPeakHourRule("deepseek");
    expect(rule).toBeDefined();
    expect(rule!.sensitive_model_ids).toContain("deepseek-v4-pro");
    expect(rule!.fallback_model_id).toBe("deepseek-v4-flash");
    expect(rule!.policy_basis).toBe("official");
    expect(rule!.windows).toEqual([
      { start_hour: 9, end_hour: 12 },
      { start_hour: 14, end_hour: 18 },
    ]);
  });
});
