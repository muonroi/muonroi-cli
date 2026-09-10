/**
 * Pins that council's same-provider candidate resolution never seats a model
 * that cannot serve a text request.
 *
 * This is a second selector of the same class. It is NOT the one that produced
 * the logged failure, and the reason is worth recording: its tier preference
 * list is applied as `prefs.some((t) => m.tier === t)`, which is true for every
 * model (the list covers all three tiers), so it degenerates to "the first
 * unused model in catalog order". Measured against the real catalog with the
 * guard removed, three roles yield step-3.5-flash / step-3.5-flash-2603 /
 * step-3.7-flash — safe purely because stepfun happens to list its text rows
 * first. A FOURTH role walks off the end of that accident and yields
 * `stepaudio-2.5-chat` (context_window 0). Hence four roles below: three would
 * pass with or without the fix and prove nothing.
 *
 * Runs against the REAL catalog; only the keychain is stubbed, because the
 * method refuses to resolve anything for a provider with no credentials.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../providers/keychain.js", () => ({
  loadKeyForProvider: async () => "test-key",
  getConfiguredProviders: async () => [],
}));

import {
  canServeTextRequests,
  getModelInfo,
  getModelsForProvider,
  getTextModelsForProvider,
  loadCatalog,
  MODELS,
} from "../../models/registry.js";
import { CouncilManager } from "../council-manager.js";

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

beforeAll(async () => {
  await loadCatalog();
});

describe("CouncilManager.resolveSameProviderCandidates", () => {
  it("seats only text-capable models on a provider whose catalog mixes modalities", async () => {
    const provider = findMixedProvider();
    const sessionModel = getTextModelsForProvider(provider)[0]!.id;
    const mgr = new CouncilManager({
      getModelId: () => sessionModel,
      getSessionId: () => null,
      hasSessionStore: () => false,
      getMessages: () => [],
      getBash: () => ({}) as never,
      getMode: () => "agent",
    });

    // Four roles: the first three are safe by catalog ordering alone (see the
    // file header), so only the fourth exercises the guard.
    const candidates = await mgr.resolveSameProviderCandidates(provider as never, [
      "implement",
      "verify",
      "research",
      "leader",
    ]);

    expect(candidates.length).toBe(4);
    for (const c of candidates) {
      const info = getModelInfo(c.model);
      expect(info, `role ${c.role}: unknown model ${c.model}`).toBeDefined();
      // Independent pre-existing oracle + the new discriminator must agree.
      expect(info!.contextWindow, `role ${c.role}: seated ${c.model}, which publishes no text context`).toBeGreaterThan(
        0,
      );
      expect(canServeTextRequests(info!), `role ${c.role}: seated non-text model ${c.model}`).toBe(true);
    }
  });

  it("still fills every role for a provider that has no non-text rows", async () => {
    // Guards against the fix narrowing text providers: the filter must be a
    // no-op wherever the catalog has nothing non-text to remove.
    const provider = [...new Set(MODELS.map((m) => m.provider ?? ""))].find(
      (p) => p !== "" && getModelsForProvider(p).every(canServeTextRequests) && getModelsForProvider(p).length >= 2,
    );
    expect(provider, "expected an all-text provider in the catalog").toBeDefined();

    const mgr = new CouncilManager({
      getModelId: () => getModelsForProvider(provider!)[0]!.id,
      getSessionId: () => null,
      hasSessionStore: () => false,
      getMessages: () => [],
      getBash: () => ({}) as never,
      getMode: () => "agent",
    });
    const candidates = await mgr.resolveSameProviderCandidates(provider as never, ["implement", "verify", "research"]);
    // The filter has nothing to remove here, so every role is still filled from
    // the provider's own catalog list. (A provider with fewer models than roles
    // legitimately reuses one — that pre-existing behaviour is unchanged.)
    const eligible = getTextModelsForProvider(provider!).map((m) => m.id);
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(eligible, `role ${c.role}: ${c.model} is not on the provider`).toContain(c.model);
      expect(canServeTextRequests(getModelInfo(c.model)!)).toBe(true);
    }
  });
});
