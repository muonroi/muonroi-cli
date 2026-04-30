import { describe, expect, test } from "bun:test";
import {
  MODELS,
  getModelIds,
  getModelInfo,
  normalizeModelId,
  getEffectiveReasoningEffort,
  getSupportedReasoningEfforts,
} from "../registry";

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
    expect(ids).toContain("claude-sonnet-4-6-20250514");
  });
});

describe("getModelInfo", () => {
  test("returns info for known model", () => {
    const info = getModelInfo("claude-sonnet-4-6-20250514");
    expect(info).toBeDefined();
    expect(info!.name).toBe("Claude Sonnet 4.6");
    expect(info!.contextWindow).toBe(200_000);
  });

  test("returns info via alias", () => {
    const info = getModelInfo("claude-sonnet-4-6-latest");
    expect(info).toBeDefined();
    expect(info!.id).toBe("claude-sonnet-4-6-20250514");
  });

  test("returns undefined for unknown model", () => {
    expect(getModelInfo("nonexistent-model")).toBeUndefined();
  });
});

describe("normalizeModelId", () => {
  test("resolves alias to canonical ID", () => {
    expect(normalizeModelId("claude-sonnet-4-6-latest")).toBe("claude-sonnet-4-6-20250514");
  });

  test("passes through unknown IDs unchanged", () => {
    expect(normalizeModelId("custom-model-123")).toBe("custom-model-123");
  });

  test("passes through canonical IDs unchanged", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20250514")).toBe("claude-sonnet-4-6-20250514");
  });
});

describe("getEffectiveReasoningEffort", () => {
  test("returns provided effort for reasoning model", () => {
    expect(getEffectiveReasoningEffort("claude-sonnet-4-6-20250514", "high")).toBe("high");
  });

  test("returns undefined when no effort provided", () => {
    expect(getEffectiveReasoningEffort("claude-sonnet-4-6-20250514", undefined)).toBeUndefined();
  });
});

describe("getSupportedReasoningEfforts", () => {
  test("returns efforts for reasoning-capable model", () => {
    const efforts = getSupportedReasoningEfforts("claude-sonnet-4-6-20250514");
    expect(efforts.length).toBeGreaterThan(0);
  });
});
