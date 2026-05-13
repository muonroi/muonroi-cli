import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EERouteResult } from "../../ee/bridge.js";
import type { ModelInfo } from "../../types/index.js";
import { resolveRoles } from "../role-registry.js";

const inventory: ModelInfo[] = [
  { id: "anthropic-premium-1", provider: "anthropic", tier: "premium" } as ModelInfo,
  { id: "openai-premium-1", provider: "openai", tier: "premium" } as ModelInfo,
  { id: "openai-balanced-1", provider: "openai", tier: "balanced" } as ModelInfo,
  { id: "google-balanced-1", provider: "google", tier: "balanced" } as ModelInfo,
  { id: "deepseek-fast-1", provider: "deepseek", tier: "fast" } as ModelInfo,
  { id: "siliconflow-balanced-1", provider: "siliconflow", tier: "balanced" } as ModelInfo,
];

describe("resolveRoles + EE override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies eeRouteOverride to mark assignment source=ee", async () => {
    const eeRouteOverride = vi.fn(async (slot): Promise<EERouteResult | null> => {
      if (slot === "Implementer") {
        return {
          tier: "fast",
          model: "deepseek-fast-1",
          confidence: 0.9,
          source: "history",
          reason: "past success",
          taskHash: "h1",
        };
      }
      return null;
    });

    const result = await resolveRoles({ inventory, eeRouteOverride });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.roles.Implementer.model).toBe("deepseek-fast-1");
      expect(result.roles.Implementer.source).toBe("ee");
      // Other slots fall back to cold-start
      expect(result.roles.PO.source).toBe("cold-start");
    }
    // EE override called for every slot (registry asks per slot)
    expect(eeRouteOverride).toHaveBeenCalled();
  });

  it("ignores EE override when model is not in inventory", async () => {
    const eeRouteOverride = vi.fn(
      async (): Promise<EERouteResult | null> => ({
        tier: "premium",
        model: "ghost-model-not-in-inventory",
        confidence: 0.99,
        source: "history",
        reason: "phantom",
        taskHash: "h",
      }),
    );

    const result = await resolveRoles({ inventory, eeRouteOverride });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // Every slot must remain cold-start because the EE-suggested model is unknown
      for (const slot of Object.keys(result.roles) as Array<keyof typeof result.roles>) {
        expect(result.roles[slot].source).toBe("cold-start");
      }
    }
  });

  it("does not collapse PO/Customer onto same model when EE picks one for both", async () => {
    const eeRouteOverride = vi.fn(async (slot): Promise<EERouteResult | null> => {
      if (slot === "PO" || slot === "Customer") {
        return {
          tier: "premium",
          model: "anthropic-premium-1",
          confidence: 0.95,
          source: "history",
          reason: "best",
          taskHash: "h",
        };
      }
      return null;
    });

    const result = await resolveRoles({ inventory, eeRouteOverride });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.roles.PO.model).not.toBe(result.roles.Customer.model);
    }
  });
});
