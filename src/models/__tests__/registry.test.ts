import { beforeAll, describe, expect, test } from "vitest";
import { resolveModelForTask, type TierLookup } from "../../orchestrator/sub-agent-model-tier.js";
import {
  getEffectiveReasoningEffort,
  getModelByTier,
  getModelIds,
  getModelInfo,
  getSupportedReasoningEfforts,
  loadCatalog,
  MODELS,
  normalizeModelId,
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

  test("siliconflow and google models are excluded from tier routing (explicit -m only)", () => {
    expect(getModelByTier("fast", "siliconflow")).toBeUndefined();
    expect(getModelByTier("balanced", "siliconflow")).toBeUndefined();
    expect(getModelByTier("premium", "siliconflow")).toBeUndefined();
    expect(getModelByTier("fast", "google")).toBeUndefined();
    expect(getModelInfo("deepseek-ai/DeepSeek-V4-Flash")?.tierRouting).toBe(false);
    expect(getModelInfo("gemini-3-flash")?.tierRouting).toBe(false);
  });
});
