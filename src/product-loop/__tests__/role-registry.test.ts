import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/index.js";
import { resolveRoles } from "../role-registry.js";

const mockInventory: ModelInfo[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    tier: "premium" as any,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    tier: "balanced" as any,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    tier: "premium" as any,
    contextWindow: 200000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
  {
    id: "claude-3-haiku",
    name: "Claude 3 Haiku",
    provider: "anthropic",
    tier: "balanced" as any,
    contextWindow: 200000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
  {
    id: "o1",
    name: "o1",
    provider: "openai",
    tier: "premium" as any,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    description: "",
  },
  {
    id: "o1-mini",
    name: "o1-mini",
    provider: "openai",
    tier: "balanced" as any,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    description: "",
  },
  {
    id: "llama-3-70b",
    name: "Llama 3 70b",
    provider: "meta",
    tier: "balanced" as any,
    contextWindow: 8000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
  {
    id: "llama-3-8b",
    name: "Llama 3 8b",
    provider: "meta",
    tier: "fast" as any,
    contextWindow: 8000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
  },
];

describe("role-registry resolution", () => {
  it("assigns cross-provider for PO and Customer when available", async () => {
    const result = await resolveRoles({ inventory: mockInventory });
    if (result.kind !== "ok") throw new Error("Expected ok result");

    expect(result.roles.PO.provider).not.toBe(result.roles.Customer.provider);
    expect(result.roles.PO.model).not.toBe(result.roles.Customer.model);
    expect(result.sameProvider).toBe(false);
  });

  it("assigns different models on same provider when only one provider has enough models", async () => {
    const singleProviderInventory = mockInventory.filter((m) => m.provider === "openai");
    // openai has gpt-4o, gpt-4o-mini, o1, o1-mini (4 models)
    // We need 6 models for a successful run.
    const inventoryWith6Models: ModelInfo[] = [
      ...singleProviderInventory,
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5",
        provider: "openai",
        tier: "fast" as any,
        contextWindow: 16000,
        inputPrice: 0,
        outputPrice: 0,
        reasoning: false,
        description: "",
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        provider: "openai",
        tier: "premium" as any,
        contextWindow: 128000,
        inputPrice: 0,
        outputPrice: 0,
        reasoning: false,
        description: "",
      },
    ];

    const result = await resolveRoles({ inventory: inventoryWith6Models });
    if (result.kind !== "ok") throw new Error("Expected ok result");

    expect(result.roles.PO.provider).toBe("openai");
    expect(result.roles.Customer.provider).toBe("openai");
    expect(result.roles.PO.model).not.toBe(result.roles.Customer.model);
    expect(result.sameProvider).toBe(true);

    const modelIds = Object.values(result.roles).map((r) => r.model);
    const uniqueModels = new Set(modelIds);
    expect(uniqueModels.size).toBe(6);
  });

  it("refuses if single provider has only 5 models", async () => {
    const inventoryWith5Models: ModelInfo[] = mockInventory
      .filter((m) => m.provider === "openai")
      .concat([
        {
          id: "gpt-3.5-turbo",
          name: "GPT-3.5",
          provider: "openai",
          tier: "fast" as any,
          contextWindow: 16000,
          inputPrice: 0,
          outputPrice: 0,
          reasoning: false,
          description: "",
        },
      ]);
    expect(inventoryWith5Models.length).toBe(5);

    const result = await resolveRoles({ inventory: inventoryWith5Models });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("single_provider_too_few");
    }
  });

  it("honors tier preferences when ample models available", async () => {
    const result = await resolveRoles({ inventory: mockInventory });
    if (result.kind !== "ok") throw new Error("Expected ok result");

    // PO preference: premium, balanced
    expect(["premium", "balanced"]).toContain(result.roles.PO.tier);
    // Implementer preference: balanced, fast, premium
    expect(["balanced", "fast", "premium"]).toContain(result.roles.Implementer.tier);
    // Tester preference: balanced, premium
    expect(["balanced", "premium"]).toContain(result.roles.Tester.tier);
  });

  it("applies EE override when provided and valid", async () => {
    const eeRouteOverride = async (slot: string) => {
      if (slot === "PO") {
        return {
          model: "claude-3-5-sonnet",
          tier: "premium",
          confidence: 1,
          source: "ee",
          reason: "override",
          taskHash: "123",
        };
      }
      return null;
    };

    const result = await resolveRoles({ inventory: mockInventory, eeRouteOverride });
    if (result.kind !== "ok") throw new Error("Expected ok result");

    expect(result.roles.PO.model).toBe("claude-3-5-sonnet");
    expect(result.roles.PO.source).toBe("ee");
  });

  it("ignores EE override if model is not in inventory", async () => {
    const eeRouteOverride = async (slot: string) => {
      if (slot === "PO") {
        return {
          model: "non-existent-model",
          tier: "premium",
          confidence: 1,
          source: "ee",
          reason: "override",
          taskHash: "123",
        };
      }
      return null;
    };

    const result = await resolveRoles({ inventory: mockInventory, eeRouteOverride });
    if (result.kind !== "ok") throw new Error("Expected ok result");

    expect(result.roles.PO.model).not.toBe("non-existent-model");
    expect(result.roles.PO.source).toBe("cold-start");
  });

  it("is idempotent and deterministic", async () => {
    const result1 = await resolveRoles({ inventory: mockInventory });
    const result2 = await resolveRoles({ inventory: mockInventory });
    expect(result1).toEqual(result2);
  });
});
