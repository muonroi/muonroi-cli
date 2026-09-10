import type { EERouteResult } from "../ee/bridge.js";
import { canServeTextRequests } from "../models/registry.js";
import type { ModelInfo, ModelTier } from "../types/index.js";
import type { RoleSlot } from "./types.js";

export interface ModelAssignment {
  slot: RoleSlot;
  provider: string;
  model: string;
  tier: ModelTier;
  source: "ee" | "cold-start";
}

export type RoleResolutionResult =
  | { kind: "ok"; roles: Record<RoleSlot, ModelAssignment>; sameProvider: boolean }
  /**
   * `no_inventory` — zero text-capable models: genuinely unfillable.
   * `po_customer_collision` — only one distinct text model, so done-gate's
   *   PO ↔ Customer debate would be an echo chamber by necessity.
   *
   * `single_provider_too_few` was removed with the `inventory.length <= 5`
   * threshold it belonged to: a small pool now REUSES models across slots
   * instead of refusing. Nothing outside this module ever read the reason —
   * every consumer only distinguishes `ok` from `refuse`.
   */
  | { kind: "refuse"; reason: "po_customer_collision" | "no_inventory" };

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
  const { eeRouteOverride } = opts;

  // Every slot below is filled by prompting the model for text: sprint-runner
  // feeds the Architect/PO model to per-sprint planning (sprint-runner.ts:964)
  // and the Reviewer model to the criteria judge (sprint-runner.ts:1788), both
  // via the council LLM. Drop anything that cannot serve a text request BEFORE
  // the tier scan, and before the EE override is matched against the inventory,
  // so neither path can reach one.
  //
  // Measured: with the full stepfun catalog as inventory this function assigned
  // a non-text model to THREE of the six slots — Implementer=step-image-edit-2,
  // Tester=stepaudio-2.5-chat, Reviewer=stepaudio-2.5-realtime — because the
  // tier scan matches on `tier` alone and six stepfun rows carry an ordinary
  // tier while publishing no text context.
  //
  // The Reviewer pick is what surfaced: three criteria-judge calls across two
  // runs, three 404s ("The model \"stepaudio-2.5-realtime\" does not exist or
  // you do not have access to it"), each ~1.0-1.2s after its sprint's judgment
  // stage began. 3/3. That is why CriteriaMet was 0 and score 0.00 in every
  // sprint of both runs: a 404 from the seated model is a thrown call, so the
  // `?? PO ?? sessionModelId` chain never engages — it only covers an
  // UNRESOLVED assignment, not a resolved-but-dead one.
  // All six slots pinned by src/models/__tests__/text-capability.test.ts.
  //
  // A provider with fewer TEXT models than slots REUSES models across slots
  // (see pickModel) rather than refusing. It must not refuse: a refusal becomes
  // an empty Map in resolveRoleAssignments (./index.ts), and runCustomerDebate
  // (./done-gate.ts) reads `roleAssignments.get("PO")`, finds undefined and
  // returns `{pass: false, reason: "missing_roles"}` — so done-gate Cond #4
  // could NEVER pass for a single-provider user. Measured on the real config
  // (defaultProvider stepfun, every other provider disabled): 9 rows in, 3 text,
  // `{"kind":"refuse","reason":"single_provider_too_few"}`, Map(0).
  const inventory = opts.inventory.filter(canServeTextRequests);

  if (inventory.length === 0) {
    return { kind: "refuse", reason: "no_inventory" };
  }

  // The old gate here was `providers.size === 1 && inventory.length <= 5`.
  // REMOVED, not re-tuned: any count-based threshold is the wrong test, and this
  // one was only ever satisfied because the pool was PADDED by the six stepfun
  // media rows — the exact rows the text guard removes. What actually has a
  // consumer contract is not "how many models" but "can PO and Customer differ":
  // runCustomerDebate refuses only on the IDENTICAL model (echo_chamber) and
  // otherwise scores same-provider/different-tier at 3 rounds and
  // same-provider/same-tier/different-model at 5. So the only unfillable shapes
  // are zero text models (above) and one (below); everything from two upward is
  // a debate that function already knows how to run.
  //
  // One text model refuses rather than filling six identical slots: PO and
  // Customer would collide by necessity, runCustomerDebate would reject that as
  // echo_chamber anyway, so filling buys the gate nothing while losing the
  // honest signal that this provider cannot support a cross-model debate. The
  // reason changes from `single_provider_too_few` to `po_customer_collision`,
  // which names the actual obstruction; both are refusals, so every consumer
  // sees the same empty-Map outcome it saw before.
  if (new Set(inventory.map((m) => m.id)).size < 2) {
    return { kind: "refuse", reason: "po_customer_collision" };
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

  const assign = (slot: RoleSlot, m: ModelInfo): ModelAssignment => ({
    slot,
    provider: m.provider || "unknown",
    model: m.id,
    tier: (m.tier as ModelTier) || "balanced",
    source: "cold-start",
  });

  /**
   * Pick a model for one slot.
   *
   * Two bands, in order. The UNUSED band is exactly the pre-existing logic and
   * runs first, so any inventory with at least six distinct models produces
   * byte-identical assignments to before — multi-provider users do not move.
   * The REUSE band only runs once the pool is exhausted, which is precisely the
   * single-provider case that used to refuse.
   *
   * `forbiddenProvider` stays SOFT (a preference, dropped if unsatisfiable, as
   * it always was). `excludeModels` is HARD and honoured in every pass: it
   * carries the one constraint with a real consumer contract — PO ≠ Customer,
   * which done-gate's runCustomerDebate reads as "not an echo chamber".
   */
  function pickModel(
    slot: RoleSlot,
    opts?: { forbiddenProvider?: string; excludeModels?: ReadonlySet<string> },
  ): ModelAssignment | null {
    const forbiddenProvider = opts?.forbiddenProvider;
    const eligible = (m: ModelInfo) => !opts?.excludeModels?.has(m.id);
    const preferences = TIER_PREFERENCES[slot];

    // ── Band 1: prefer a model no slot has taken yet (unchanged behaviour) ──
    for (const tier of preferences) {
      const match = sortedInventory.find(
        (m) =>
          eligible(m) &&
          (m.tier || "balanced") === tier &&
          !usedModelIds.has(m.id) &&
          (!forbiddenProvider || m.provider !== forbiddenProvider),
      );
      if (match) return assign(slot, match);
    }
    // Fallback: ignore forbiddenProvider if we couldn't find a match
    if (forbiddenProvider) {
      for (const tier of preferences) {
        const match = sortedInventory.find(
          (m) => eligible(m) && (m.tier || "balanced") === tier && !usedModelIds.has(m.id),
        );
        if (match) return assign(slot, match);
      }
    }
    // Final fallback within band 1: ignore tier preference
    const fallback = sortedInventory.find((m) => eligible(m) && !usedModelIds.has(m.id));
    if (fallback) return assign(slot, fallback);

    // ── Band 2: REUSE — the pool is smaller than the slot count ─────────────
    // Tier preference still leads, so a reused pick is the right KIND of model
    // for the slot rather than whatever happens to sort first.
    for (const tier of preferences) {
      const match = sortedInventory.find(
        (m) =>
          eligible(m) && (m.tier || "balanced") === tier && (!forbiddenProvider || m.provider !== forbiddenProvider),
      );
      if (match) return assign(slot, match);
    }
    for (const tier of preferences) {
      const match = sortedInventory.find((m) => eligible(m) && (m.tier || "balanced") === tier);
      if (match) return assign(slot, match);
    }
    const anyEligible = sortedInventory.find(eligible);
    if (anyEligible) {
      return assign(slot, anyEligible);
    }
    return null;
  }

  // 1. Resolve PO first (most important)
  const po = pickModel("PO");
  if (!po) return { kind: "refuse", reason: "no_inventory" }; // Should not happen given initial check
  assignments.PO = po;
  usedModelIds.add(po.model);

  // 2. Resolve Customer next: a different PROVIDER if the inventory allows one
  // (soft), but a different MODEL always (hard). The hard exclusion is what
  // keeps the reuse band from collapsing this pair into an echo chamber on a
  // single-provider pool — done-gate's runCustomerDebate is the consumer, and
  // "identical model" is the one shape it refuses outright.
  const customer = pickModel("Customer", {
    forbiddenProvider: po.provider,
    excludeModels: new Set([po.model]),
  });
  if (!customer) return { kind: "refuse", reason: "no_inventory" };
  assignments.Customer = customer;
  usedModelIds.add(customer.model);

  // Safety net. With >= 2 distinct models the exclusion above already guarantees
  // this, and a 1-model pool refused before reaching here — so this now fires
  // only if one of those invariants is ever broken.
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
  //
  // Phase 21.5 hotfix: query EE for all role slots IN PARALLEL. Sequential
  // awaits used to multiply the per-call EE timeout by ROLE_SLOTS.length —
  // when EE is unreachable that meant 6× the route timeout (~6s with the
  // 1000ms default) before /ideal hot-path could yield its first Sprint
  // chunk. The override lambda already swallows errors and returns null on
  // failure, so Promise.all preserves semantics.
  if (eeRouteOverride) {
    const overrides = await Promise.all(ROLE_SLOTS.map((slot) => eeRouteOverride(slot).catch(() => null)));
    for (let i = 0; i < ROLE_SLOTS.length; i++) {
      const slot = ROLE_SLOTS[i]!;
      const override = overrides[i];
      if (override) {
        // Only apply if it's in inventory AND doesn't cause PO/Customer collision if slot is PO/Customer
        const inInventory = inventory.find((m) => m.id === override.model);
        if (inInventory) {
          const _currentAssignment = assignments[slot]!;

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
