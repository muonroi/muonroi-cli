/**
 * Regression cover for a measured defect: a council speaker slot was filled
 * with `stepaudio-2.5-realtime`, a realtime-audio endpoint, producing
 *
 *   [council.generate] call failed {"modelId":"stepaudio-2.5-realtime",
 *    "provider":"stepfun","error":"The model \"stepaudio-2.5-realtime\" does
 *    not exist or you do not have access to it."}
 *
 * in ~/.muonroi-cli/debug.log (3 occurrences on 2026-09-10, out of 12
 * `[council.generate] call failed` lines in that log).
 *
 * Everything here runs against the REAL bundled catalog via loadCatalog(). A
 * hand-authored fixture would not have caught this bug: the bug is a property of
 * the shipped catalog's shape (six stepfun rows that carry an ordinary `tier`
 * but publish no text context), so only the real catalog can express it.
 *
 * Two independent oracles are asserted together:
 *   1. `contextWindow > 0` — a PRE-EXISTING catalog property. Exactly the six
 *      non-text stepfun rows publish `context_window: 0`; all 36 text rows
 *      publish >= 128000. Being independent of the fix, this is the oracle that
 *      made the fail-first run fail.
 *   2. `canServeTextRequests()` — the discriminator the fix introduces.
 * Requiring both means a future row that satisfies one and not the other is
 * caught here rather than as a provider 404 in someone's council run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRoles } from "../../product-loop/role-registry.js";
import type { ModelInfo } from "../../types/index.js";
import { fetchCatalogDocument, validateCatalogModalityCoverage } from "../catalog-client.js";
import {
  canServeTextRequests,
  getModelByTier,
  getModelInfo,
  getModelsForProvider,
  getTextModelsForProvider,
  loadCatalog,
  MODELS,
} from "../registry.js";

/**
 * The provider whose catalog mixes text and non-text rows — found by SHAPE, so
 * this test keeps testing the real hazard if the offending provider is renamed,
 * removed, or joined by another one.
 */
function findMixedProviders(): string[] {
  const providers = [...new Set(MODELS.map((m) => m.provider ?? ""))];
  const mixed = providers.filter(
    (p) =>
      MODELS.some((m) => m.provider === p && canServeTextRequests(m)) &&
      MODELS.some((m) => m.provider === p && !canServeTextRequests(m)),
  );
  expect(mixed.length, "no provider in the catalog mixes text and non-text rows").toBeGreaterThan(0);
  return mixed;
}

function expectTextCapable(modelId: string, where: string): void {
  const info = getModelInfo(modelId);
  expect(info, `${where}: selected unknown model id ${modelId}`).toBeDefined();
  // Oracle 1 — pre-existing catalog property, independent of the fix.
  expect(info!.contextWindow, `${where}: selected ${modelId}, which publishes no text context window`).toBeGreaterThan(
    0,
  );
  // Oracle 2 — the discriminator the fix introduces.
  expect(canServeTextRequests(info!), `${where}: selected non-text model ${modelId}`).toBe(true);
}

beforeAll(async () => {
  await loadCatalog();
});

describe("catalog modality declaration", () => {
  it("every bundled model declares modalities explicitly", async () => {
    // The field is optional in the schema so a remote/third-party catalog keeps
    // working without it. This repo's own catalog may not lean on that default:
    // an audio row added without a declaration would inherit "text" and reach a
    // council seat again. Omission must fail here, not at runtime.
    const doc = await fetchCatalogDocument();
    expect(validateCatalogModalityCoverage(doc)).toEqual([]);
  });

  it("declared modalities agree with the independent context_window signal", () => {
    for (const m of MODELS) {
      expect(canServeTextRequests(m), `${m.id}: modality declaration disagrees with context_window`).toBe(
        m.contextWindow > 0,
      );
    }
  });

  it("treats a model that omits modalities as text — an absent field never disqualifies", () => {
    const future: ModelInfo = {
      id: "future-text-model",
      name: "Future text model",
      contextWindow: 128000,
      inputPrice: 0,
      outputPrice: 0,
      reasoning: false,
      description: "hypothetical model added before it declares a modality",
      // deliberately no `modalities` AND no `roles`
    };
    expect(canServeTextRequests(future)).toBe(true);
  });

  it("applies the absent-field rule to BOTH signals, not just modalities", () => {
    // A ModelInfo stating neither `modalities` nor a context window is "not
    // stated", not "cannot do text". Only a DECLARED zero disqualifies.
    // Existing fixtures construct exactly this shape (see
    // src/product-loop/__tests__/role-routing-ee.test.ts) and must keep
    // resolving — an earlier draft of this guard required `contextWindow > 0`
    // and broke all three of them.
    const unstated = { id: "unstated", provider: "p", tier: "premium" } as unknown as ModelInfo;
    expect(canServeTextRequests(unstated)).toBe(true);

    // A DECLARED zero budget is a statement, and does disqualify.
    const declaredZero = { id: "zero", provider: "p", tier: "premium", contextWindow: 0 } as unknown as ModelInfo;
    expect(canServeTextRequests(declaredZero)).toBe(false);
  });

  it("excludes a converter in both directions", () => {
    const base = { name: "x", inputPrice: 0, outputPrice: 0, reasoning: false, description: "" };
    // text-in / audio-out: can read the prompt, cannot return the answer.
    expect(
      canServeTextRequests({
        ...base,
        id: "tts",
        contextWindow: 128000,
        modalities: { input: ["text"], output: ["audio"] },
      }),
    ).toBe(false);
    // audio-in / text-out: can return text, cannot read the prompt.
    expect(
      canServeTextRequests({
        ...base,
        id: "asr",
        contextWindow: 128000,
        modalities: { input: ["audio"], output: ["text"] },
      }),
    ).toBe(false);
    // text+image-in / text-out: a vision chat model stays eligible.
    expect(
      canServeTextRequests({
        ...base,
        id: "vision",
        contextWindow: 128000,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    ).toBe(true);
  });
});

describe("getTextModelsForProvider", () => {
  it("drops non-text rows and preserves catalog order for every text row", () => {
    for (const provider of findMixedProviders()) {
      const all = getModelsForProvider(provider);
      const text = getTextModelsForProvider(provider);
      expect(text.length).toBeLessThan(all.length);
      // Membership AND order for text rows are byte-identical to before —
      // nothing is reordered, only non-text candidates are removed.
      expect(text.map((m) => m.id)).toEqual(all.filter((m) => m.contextWindow > 0).map((m) => m.id));
    }
  });

  it("keeps role-less TEXT models selectable — a `has roles` filter would delete them", () => {
    // Guards the trap this fix deliberately avoided: several catalog rows carry
    // no `roles` array yet are ordinary text (or text+vision) models. `roles` is
    // a routing concept, not a modality one.
    const rolelessText = MODELS.filter((m) => !m.roles?.length && canServeTextRequests(m));
    expect(rolelessText.length, "expected role-less text models in the catalog").toBeGreaterThan(0);
    for (const m of rolelessText) {
      const kept = getTextModelsForProvider(m.provider ?? "").some((x) => x.id === m.id);
      expect(kept, `${m.provider}/${m.id} carries no roles but is text — it must stay selectable`).toBe(true);
    }
  });
});

describe("getModelByTier", () => {
  it("never returns a non-text model for any provider/tier pair", () => {
    for (const provider of [...new Set(MODELS.map((m) => m.provider ?? ""))]) {
      for (const tier of ["fast", "balanced", "premium"] as const) {
        const m = getModelByTier(tier, provider);
        if (m) expectTextCapable(m.id, `getModelByTier(${tier}, ${provider})`);
      }
    }
  });
});

describe("product-loop role-registry — the path that produced the measured failure", () => {
  it("assigns a text model to EVERY slot, not just the ones that broke", async () => {
    // Before the fix, three of the six slots got a non-text model on the tip:
    //   PO          -> step-3.7-flash          (ok)
    //   Customer    -> step-3.5-flash          (ok)
    //   Architect   -> step-3.5-flash-2603     (ok)
    //   Implementer -> step-image-edit-2       (context_window 0)
    //   Tester      -> stepaudio-2.5-chat      (context_window 0)
    //   Reviewer    -> stepaudio-2.5-realtime  (context_window 0)
    // Only Reviewer surfaced, because sprint-runner.ts:1788 seats it as the
    // criteria judge. Assert over ALL slots so a future regression that moves
    // the damage to Implementer or Tester still fails here.
    const EXPECTED_SLOTS = ["PO", "Architect", "Implementer", "Tester", "Reviewer", "Customer"];
    for (const provider of findMixedProviders()) {
      const result = await resolveRoles({ inventory: getModelsForProvider(provider) });
      // Must ASSIGN, not refuse. An earlier draft of this guard let the filtered
      // pool fall through to `single_provider_too_few`, which reaches done-gate
      // as an empty Map and fails Cond #4 permanently. See
      // src/product-loop/__tests__/role-registry-reuse.test.ts.
      expect(result.kind, `${provider}: expected an assignment, got ${JSON.stringify(result)}`).toBe("ok");
      if (result.kind !== "ok") continue;
      // Every slot is present AND text-capable — an assignment that silently
      // dropped a slot would otherwise pass a per-entry loop vacuously.
      expect(Object.keys(result.roles).sort()).toEqual([...EXPECTED_SLOTS].sort());
      for (const slot of EXPECTED_SLOTS) {
        const a = result.roles[slot as keyof typeof result.roles];
        expect(a, `role-registry slot ${slot} unassigned`).toBeDefined();
        expectTextCapable(a.model, `role-registry slot ${slot}`);
      }
    }
  });

  it("ignores an EE override that names a non-text model", async () => {
    const provider = findMixedProviders()[0]!;
    const nonText = getModelsForProvider(provider).find((m) => !canServeTextRequests(m))!;
    const inventory = [...getTextModelsForProvider(provider), ...MODELS.filter((m) => m.provider !== provider)];
    const result = await resolveRoles({
      inventory,
      eeRouteOverride: async () => ({ model: nonText.id, tier: nonText.tier }) as never,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    for (const [slot, a] of Object.entries(result.roles)) {
      expectTextCapable(a.model, `role-registry slot ${slot} (EE override)`);
    }
  });

  it("removes candidates without reordering — the guard is a filter, not a re-rank", async () => {
    // Property, not a golden list: assigning over the FULL catalog must produce
    // exactly the assignment you get from the text rows alone. That holds only
    // if the guard removes non-text candidates and changes nothing else about
    // priority or order, which is the constraint on this fix.
    const viaFull = await resolveRoles({ inventory: MODELS });
    const viaTextOnly = await resolveRoles({ inventory: MODELS.filter(canServeTextRequests) });
    expect(viaFull.kind).toBe("ok");
    expect(viaTextOnly.kind).toBe("ok");
    if (viaFull.kind !== "ok" || viaTextOnly.kind !== "ok") return;
    expect(Object.entries(viaFull.roles).map(([slot, a]) => `${slot}=${a.model}`)).toEqual(
      Object.entries(viaTextOnly.roles).map(([slot, a]) => `${slot}=${a.model}`),
    );
    for (const [slot, a] of Object.entries(viaFull.roles)) {
      expectTextCapable(a.model, `role-registry slot ${slot} (full catalog)`);
    }
  });
});
