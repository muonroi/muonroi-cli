import type { RoleSlot } from "./types.js";
import type { ModelInfo, ModelTier } from "../types/index.js";
import type { EERouteResult } from "../ee/bridge.js";

export interface ModelAssignment {
  slot: RoleSlot;
  provider: string;
  model: string;
  tier: ModelTier;
  source: "ee" | "cold-start";
}

export type RoleResolutionResult =
  | { kind: "ok"; roles: Record<RoleSlot, ModelAssignment>; sameProvider: boolean }
  | { kind: "refuse"; reason: "single_provider_too_few" | "po_customer_collision" | "no_inventory" };

const ROLE_SLOTS: RoleSlot[] = ["PO", "Architect", "Implementer", "Tester", "Reviewer", "Customer"];

const TIER_PREFERENCES: Record<RoleSlot, ModelTier[]> = {
  PO: ["premium", "balanced"],
  Architect: ["premium", "balanced"],
  Reviewer: ["premium", "balanced"],
  Customer: ["premium", "balanced"],
  Implementer: ["balanced", "fast", "premium"],
  Tester: ["balanced", "premium"],
};

export async function resolveRoles(opts: {
  inventory: ModelInfo[];
  eeRouteOverride?: (slot: RoleSlot) => Promise<EERouteResult | null>;
}): Promise<RoleResolutionResult> {
  const { inventory, eeRouteOverride } = opts;

  if (inventory.length === 0) {
    return { kind: "refuse", reason: "no_inventory" };
  }

  const providers = new Set(inventory.map((m) => m.provider));
  if (providers.size === 1 && inventory.length <= 5) {
    return { kind: "refuse", reason: "single_provider_too_few" };
  }

  // Stable sort inventory: tier (premium > balanced > fast), provider, id
  const tierRank: Record<ModelTier, number> = { premium: 0, balanced: 1, fast: 2 };
  const sortedInventory = [...inventory].sort((a, b) => {
    const rA = tierRank[a.tier || "balanced"];
    const rB = tierRank[b.tier || "balanced"];
    if (rA !== rB) return rA - rB;
    if (a.provider !== b.provider) return (a.provider || "").localeCompare(b.provider || "");
    return a.id.localeCompare(b.id);
  });

  const assignments: Partial<Record<RoleSlot, ModelAssignment>> = {};
  const usedModelIds = new Set<string>();

  // Helper to pick a model
  function pickModel(slot: RoleSlot, forbiddenProvider?: string): ModelAssignment | null {
    const preferences = TIER_PREFERENCES[slot];
    for (const tier of preferences) {
      const match = sortedInventory.find(
        (m) =>
          (m.tier || "balanced") === tier &&
          !usedModelIds.has(m.id) &&
          (!forbiddenProvider || m.provider !== forbiddenProvider),
      );
      if (match) {
        return {
          slot,
          provider: match.provider || "unknown",
          model: match.id,
          tier: (match.tier as ModelTier) || "balanced",
          source: "cold-start",
        };
      }
    }
    // Fallback: ignore forbiddenProvider if we couldn't find a match
    if (forbiddenProvider) {
      for (const tier of preferences) {
        const match = sortedInventory.find((m) => (m.tier || "balanced") === tier && !usedModelIds.has(m.id));
        if (match) {
          return {
            slot,
            provider: match.provider || "unknown",
            model: match.id,
            tier: (match.tier as ModelTier) || "balanced",
            source: "cold-start",
          };
        }
      }
    }
    // Final fallback: ignore tier preference
    const fallback = sortedInventory.find((m) => !usedModelIds.has(m.id));
    if (fallback) {
      return {
        slot,
        provider: fallback.provider || "unknown",
        model: fallback.id,
        tier: (fallback.tier as ModelTier) || "balanced",
        source: "cold-start",
      };
    }
    return null;
  }

  // 1. Resolve PO first (most important)
  const po = pickModel("PO");
  if (!po) return { kind: "refuse", reason: "no_inventory" }; // Should not happen given initial check
  assignments.PO = po;
  usedModelIds.add(po.model);

  // 2. Resolve Customer next, try different provider
  const customer = pickModel("Customer", po.provider);
  if (!customer) return { kind: "refuse", reason: "no_inventory" };
  assignments.Customer = customer;
  usedModelIds.add(customer.model);

  // Check for PO/Customer collision
  if (assignments.PO.model === assignments.Customer.model) {
    return { kind: "refuse", reason: "po_customer_collision" };
  }

  // 3. Resolve others
  const others: RoleSlot[] = ["Architect", "Implementer", "Tester", "Reviewer"];
  for (const slot of others) {
    const assigned = pickModel(slot);
    if (!assigned) return { kind: "refuse", reason: "no_inventory" };
    assignments[slot] = assigned;
    usedModelIds.add(assigned.model);
  }

  // 4. Apply EE overrides last
  if (eeRouteOverride) {
    for (const slot of ROLE_SLOTS) {
      const override = await eeRouteOverride(slot);
      if (override) {
        // Only apply if it's in inventory AND doesn't cause PO/Customer collision if slot is PO/Customer
        const inInventory = inventory.find((m) => m.id === override.model);
        if (inInventory) {
          const currentAssignment = assignments[slot]!;
          
          // If we are overriding PO or Customer, we MUST ensure they remain different
          if (slot === "PO") {
            if (override.model === assignments.Customer!.model) continue;
          }
          if (slot === "Customer") {
            if (override.model === assignments.PO!.model) continue;
          }

          assignments[slot] = {
            slot,
            provider: inInventory.provider || "unknown",
            model: override.model,
            tier: (override.tier as ModelTier) || (inInventory.tier as ModelTier) || "balanced",
            source: "ee",
          };
        }
      }
    }
  }

  return {
    kind: "ok",
    roles: assignments as Record<RoleSlot, ModelAssignment>,
    sameProvider: assignments.PO!.provider === assignments.Customer!.provider,
  };
}
