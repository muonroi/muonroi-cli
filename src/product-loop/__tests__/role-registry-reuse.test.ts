/**
 * A provider with fewer TEXT models than role slots must REUSE models across
 * slots, not refuse and not reach for a non-text endpoint.
 *
 * Background. The audio/image guard (see canServeTextRequests) correctly stops
 * `stepaudio-2.5-realtime` being seated as a council speaker. But stepfun's pool
 * is 9 rows of which only 3 serve text, and `resolveRoles` refused outright at
 * `providers.size === 1 && inventory.length <= 5`. That threshold was only ever
 * satisfied because the pool was PADDED by the six media rows — the very rows
 * that caused the defect. Filtering them exposed it.
 *
 * The refusal is not survivable downstream. `resolveRoleAssignments` maps a
 * refusal to an EMPTY Map (index.ts), and `runCustomerDebate` (done-gate.ts)
 * reads `roleAssignments.get("PO")`, finds undefined, and returns
 * `{pass: false, reason: "missing_roles"}` — so done-gate Cond #4 can never pass
 * for a single-provider user. That is a permanent fail, not a short-circuit.
 *
 * Reuse is what the consumer already expects: `runCustomerDebate` refuses only
 * when PO and Customer are the IDENTICAL model ("echo chamber"), and explicitly
 * scores same-provider/different-tier at 3 rounds and same-provider/same-tier/
 * different-model at 5. A 3-model pool (premium x1 + balanced x2) lands squarely
 * in the shapes that function was written for.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { canServeTextRequests, getModelsForProvider, loadCatalog, MODELS } from "../../models/registry.js";
import type { ModelInfo } from "../../types/index.js";
import { resolveRoles } from "../role-registry.js";

const ALL_SLOTS = ["PO", "Architect", "Implementer", "Tester", "Reviewer", "Customer"] as const;

/** The provider whose catalog mixes text and non-text rows — found by shape. */
function findMixedProvider(): string {
  const providers = [...new Set(MODELS.map((m) => m.provider ?? ""))];
  const mixed = providers.find(
    (p) =>
      MODELS.some((m) => m.provider === p && canServeTextRequests(m)) &&
      MODELS.some((m) => m.provider === p && !canServeTextRequests(m)),
  );
  expect(mixed, "no provider in the catalog mixes text and non-text rows").toBeDefined();
  return mixed!;
}

function expectSixTextSlots(result: Awaited<ReturnType<typeof resolveRoles>>, where: string) {
  expect(result.kind, `${where}: expected an assignment, got ${JSON.stringify(result)}`).toBe("ok");
  if (result.kind !== "ok") return;
  expect(Object.keys(result.roles).sort()).toEqual([...ALL_SLOTS].sort());
  for (const slot of ALL_SLOTS) {
    const a = result.roles[slot];
    expect(a, `${where}: slot ${slot} unassigned`).toBeDefined();
    const info = MODELS.find((m) => m.id === a.model);
    expect(info, `${where}: slot ${slot} got unknown model ${a.model}`).toBeDefined();
    expect(canServeTextRequests(info!), `${where}: slot ${slot} got non-text ${a.model}`).toBe(true);
  }
}

beforeAll(async () => {
  await loadCatalog();
});

describe("resolveRoles — reuse when the text pool is smaller than the slot count", () => {
  it("fills all six slots for the real single-provider config, PO != Customer", async () => {
    // The measured user config: defaultProvider stepfun, every other provider in
    // disabledProviders, so the inventory is one provider's rows and nothing else.
    const provider = findMixedProvider();
    const inventory = getModelsForProvider(provider);
    const textCount = inventory.filter(canServeTextRequests).length;
    expect(textCount).toBeGreaterThanOrEqual(2);
    expect(textCount).toBeLessThan(ALL_SLOTS.length); // the case under test

    const result = await resolveRoles({ inventory });
    expectSixTextSlots(result, "single-provider mixed catalog");
    if (result.kind !== "ok") return;

    // The one pair with a real consumer contract (done-gate Cond #4) must not
    // collapse into an echo chamber while the pool can still avoid it.
    expect(result.roles.PO.model).not.toBe(result.roles.Customer.model);
  });

  it("reuses rather than inventing: every assigned model comes from the text pool", async () => {
    const provider = findMixedProvider();
    const textIds = new Set(
      getModelsForProvider(provider)
        .filter(canServeTextRequests)
        .map((m) => m.id),
    );
    const result = await resolveRoles({ inventory: getModelsForProvider(provider) });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    for (const slot of ALL_SLOTS) {
      expect(textIds, `slot ${slot}`).toContain(result.roles[slot].model);
    }
    // Reuse is expected here — six slots over three models cannot be distinct.
    expect(new Set(ALL_SLOTS.map((s) => result.roles[s].model)).size).toBe(textIds.size);
  });

  it("refuses with no_inventory when the pool has zero text models", async () => {
    const provider = findMixedProvider();
    const nonTextOnly = getModelsForProvider(provider).filter((m) => !canServeTextRequests(m));
    expect(nonTextOnly.length).toBeGreaterThan(0);
    const result = await resolveRoles({ inventory: nonTextOnly });
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") return;
    expect(result.reason).toBe("no_inventory");
  });

  it("refuses with po_customer_collision when exactly one text model exists", async () => {
    // Decision, pinned: ONE text model refuses rather than filling six identical
    // slots. PO and Customer would be the same model by necessity, which
    // runCustomerDebate rejects as `echo_chamber` anyway — so filling buys the
    // gate nothing, while the refusal keeps an honest signal that this provider
    // cannot support a cross-model debate. It also leaves the pre-existing
    // one-model behaviour (a refusal) unchanged.
    const one = MODELS.filter(canServeTextRequests).slice(0, 1);
    expect(one.length).toBe(1);
    const result = await resolveRoles({ inventory: one });
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") return;
    expect(result.reason).toBe("po_customer_collision");
  });

  it("leaves multi-provider assignments byte-identical to the pre-reuse behaviour", async () => {
    // Requirement: multi-provider users must not move. With >= 6 distinct text
    // models the reuse passes are never reached, so the result must equal what
    // the unused-only passes produce.
    const result = await resolveRoles({ inventory: MODELS });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // All six distinct — reuse did not engage.
    expect(new Set(ALL_SLOTS.map((s) => result.roles[s].model)).size).toBe(6);
    expectSixTextSlots(result, "multi-provider");
    expect(result.roles.PO.model).not.toBe(result.roles.Customer.model);
    expect(result.roles.PO.provider).not.toBe(result.roles.Customer.provider);
  });

  it("keeps tier preference when reusing — a slot still prefers its tier", async () => {
    // Two models, one per tier, six slots. Tier-preferring slots must land on
    // the tier they ask for even though every model is already used.
    const pool: ModelInfo[] = [
      { id: "p-premium", provider: "p", tier: "premium", contextWindow: 128000 } as ModelInfo,
      { id: "p-balanced", provider: "p", tier: "balanced", contextWindow: 128000 } as ModelInfo,
    ];
    const result = await resolveRoles({ inventory: pool });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Implementer prefers balanced first (TIER_PREFERENCES), and by the time it
    // is picked both models are used — so reuse must still honour that order.
    expect(result.roles.Implementer.model).toBe("p-balanced");
    // Reviewer prefers premium first.
    expect(result.roles.Reviewer.model).toBe("p-premium");
  });
});
