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
  loadCatalog,
  MODELS,
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
