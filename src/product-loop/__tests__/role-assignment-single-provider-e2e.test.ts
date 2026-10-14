/**
 * End-to-end for the real single-provider user, through the two consumers that
 * a refusal broke — asserted against the actual functions, not their comments.
 *
 * Measured config (~/.muonroi-cli/user-settings.json): defaultProvider is the
 * one provider whose catalog mixes text and media rows; every other provider is
 * in disabledProviders. Inventory is therefore that provider alone: 10 rows
 * (stepfun, after step-5-preview was added 2026-09-23), of which 4 serve text.
 *
 * Before the reuse fix this produced `{"kind":"refuse",
 * "reason":"single_provider_too_few"}` -> `resolveRoleAssignments` Map(0) ->
 * `runCustomerDebate` `{pass:false, reason:"missing_roles"}`, i.e. done-gate
 * Cond #4 could never pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const disabled = new Set<string>();
const keyed = new Set<string>();

vi.mock("../../utils/settings.js", () => ({
  isProviderDisabled: (p: string) => disabled.has(p),
}));
vi.mock("../../providers/keychain.js", () => ({
  loadKeyForProvider: async (p: string) => {
    if (!keyed.has(p)) throw new Error(`no key for ${p}`);
    return "sk-test";
  },
}));
vi.mock("../../ee/bridge.js", () => ({ routeModel: async () => null }));

import { canServeTextRequests, loadCatalog, MODELS } from "../../models/registry.js";
import { resolveRoleAssignments } from "../index.js";

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

beforeEach(async () => {
  await loadCatalog();
  disabled.clear();
  keyed.clear();
});

describe("single-provider user — the real config, end to end", () => {
  it("resolveRoleAssignments returns a NON-EMPTY map with six text slots", async () => {
    const provider = findMixedProvider();
    // Exactly the measured settings: one provider credentialed, all others off.
    keyed.add(provider);
    for (const p of new Set(MODELS.map((m) => m.provider ?? ""))) {
      if (p && p !== provider) disabled.add(p);
    }

    const textIds = MODELS.filter((m) => m.provider === provider && canServeTextRequests(m)).map((m) => m.id);
    expect(textIds.length).toBeLessThan(6); // the shape that used to refuse

    const sessionModel = textIds[0]!;
    const map = await resolveRoleAssignments(sessionModel);

    expect(map.size, "empty map => done-gate Cond #4 fails with missing_roles forever").toBe(6);
    for (const [slot, a] of map.entries()) {
      expect(textIds, `slot ${slot} got ${a.modelId}`).toContain(a.modelId);
    }
    // The pair with the consumer contract.
    expect(map.get("PO")!.modelId).not.toBe(map.get("Customer")!.modelId);
  });

  it("runCustomerDebate no longer short-circuits on missing_roles or echo_chamber", async () => {
    const provider = findMixedProvider();
    keyed.add(provider);
    for (const p of new Set(MODELS.map((m) => m.provider ?? ""))) {
      if (p && p !== provider) disabled.add(p);
    }
    const textIds = MODELS.filter((m) => m.provider === provider && canServeTextRequests(m));
    const map = await resolveRoleAssignments(textIds[0]!.id);

    // Reproduce runCustomerDebate's two refusal predicates verbatim
    // (src/product-loop/done-gate.ts) rather than driving the whole gate, which
    // needs an LLM. These two are the ones a refusal used to trip.
    const po = map.get("PO");
    const customer = map.get("Customer");
    expect(po, "missing_roles").toBeDefined();
    expect(customer, "missing_roles").toBeDefined();
    expect(
      po!.provider === customer!.provider && po!.modelId === customer!.modelId,
      "echo_chamber: PO and Customer are the identical model",
    ).toBe(false);

    // Same provider is required by this fixture (single-provider user).
    expect(po!.provider).toBe(customer!.provider);
    // Tier diversity is NOT a hard contract — role-registry.ts documents two
    // supported same-provider shapes: different-tier (3 rounds) and
    // same-tier/different-model (5 rounds). Which one comes out depends on how
    // many premium-tier text models the provider's catalog carries. Stepfun
    // measured 1 (step-3.7-flash) until step-5-preview was added 2026-09-23,
    // which made 2 premium-tier stepfun text models available, so PO and
    // Customer now both land on premium (step-3.7-flash, step-5-preview) —
    // the same-tier/different-model shape. The hard invariant, asserted above
    // via echo_chamber, is that PO and Customer are never the identical model.
    expect(po!.modelId).not.toBe(customer!.modelId);
  });
});
