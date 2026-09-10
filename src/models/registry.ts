import type { ProviderId } from "../providers/types.js";
import type { ModelInfo, ReasoningEffort } from "../types";
import type { CatalogCouncilRouting, CatalogProviderPeakHour, CatalogVisionProxyRouting } from "./catalog-client.js";
import { catalogModelToModelInfo, fetchCatalogDocument } from "./catalog-client.js";

const ALL_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

const DEFAULT_SWITCH_PROVIDER_ORDER: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

// ---------------------------------------------------------------------------
// Centralized model registry — populated by loadCatalog() at boot
// ---------------------------------------------------------------------------

export let MODELS: ModelInfo[] = [];
export let isLoading = true;
export let SWITCH_PROVIDER_ORDER: readonly ProviderId[] = DEFAULT_SWITCH_PROVIDER_ORDER;
const providerPeakHourRules = new Map<string, CatalogProviderPeakHour>();
let catalogCouncilRouting: CatalogCouncilRouting | undefined;
let catalogVisionProxyRouting: CatalogVisionProxyRouting | undefined;

/**
 * Load models + routing policies from centralized catalog (API with static fallback).
 */
export async function loadCatalog(): Promise<void> {
  isLoading = true;
  try {
    const doc = await fetchCatalogDocument();
    MODELS = doc.models.map(catalogModelToModelInfo);
    SWITCH_PROVIDER_ORDER = (doc.routing?.switch_provider_order as ProviderId[] | undefined) ?? [
      ...DEFAULT_SWITCH_PROVIDER_ORDER,
    ];
    providerPeakHourRules.clear();
    for (const [providerId, policy] of Object.entries(doc.provider_policies ?? {})) {
      if (policy.peak_hour) providerPeakHourRules.set(providerId, policy.peak_hour);
    }
    catalogCouncilRouting = doc.routing?.council;
    catalogVisionProxyRouting = doc.routing?.vision_proxy;
  } catch {
    // On total failure, MODELS stays empty — callers must handle
  } finally {
    isLoading = false;
  }
}

export function getProviderPeakHourRule(providerId: string): CatalogProviderPeakHour | undefined {
  return providerPeakHourRules.get(providerId);
}

/** Catalog-defined default council lineup (multi-provider debate slots). */
export function getCatalogCouncilRouting(): CatalogCouncilRouting | undefined {
  return catalogCouncilRouting;
}

export function getVisionProxyRouting(): CatalogVisionProxyRouting | undefined {
  return catalogVisionProxyRouting;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

export function getModelInfo(idOrAlias: string): ModelInfo | undefined {
  const direct = MODELS.find((m) => m.id === idOrAlias || m.aliases?.includes(idOrAlias));
  if (direct) return direct;
  // Gateway-prefix fallback: some routers/persisted configs prefix the model
  // id with the gateway they came through (e.g. "opencode/deepseek-v4-flash",
  // "deepseek-ai/DeepSeek-V4-Flash"). The native provider API rejects the
  // prefixed form. Retry with the last path segment so the canonical catalog
  // entry (and its provider) still resolves instead of leaking a dead id to
  // runtime. Only matches when the stripped segment is a real catalog id/alias,
  // so a non-catalog id still returns undefined (no false positives).
  const slash = idOrAlias.lastIndexOf("/");
  if (slash >= 0 && slash < idOrAlias.length - 1) {
    const tail = idOrAlias.slice(slash + 1);
    return MODELS.find((m) => m.id === tail || m.aliases?.includes(tail));
  }
  return undefined;
}

export function normalizeModelId(idOrAlias: string): string {
  const m = getModelInfo(idOrAlias);
  return m ? m.id : idOrAlias;
}

export function getEffectiveReasoningEffort(
  modelId: string,
  requestedEffort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (requestedEffort === undefined) return undefined;
  const info = getModelInfo(modelId);
  if (!info?.reasoning) return undefined;
  return requestedEffort;
}

/** Returns true if the resolved model has built-in reasoning / extended thinking. */
export function isReasoningModel(modelId: string): boolean {
  return getModelInfo(modelId)?.reasoning ?? false;
}

export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] {
  const info = getModelInfo(modelId);
  if (!info?.reasoning) return [];
  return [...ALL_REASONING_EFFORTS];
}

/**
 * Pick the first model matching a tier for a given provider.
 * If no match for provider+tier, returns first model of that tier from any provider.
 * Returns undefined if no models in that tier exist.
 */
function isTierRoutable(m: ModelInfo): boolean {
  return m.tierRouting !== false;
}

/**
 * Can this model serve a TEXT request — read a text prompt and return a text
 * completion? Every text-task selector must gate on this.
 *
 * Measured defect this exists for: a council seat was filled with
 * `stepaudio-2.5-realtime` (stepfun), which answered
 * `The model "stepaudio-2.5-realtime" does not exist or you do not have access
 * to it` — 3 occurrences in ~/.muonroi-cli/debug.log on 2026-09-10, out of 12
 * `[council.generate] call failed` lines. Reproduced deterministically in
 * `__tests__/text-capability.test.ts`: role-registry hands the Reviewer slot
 * that exact model, and `sprint-runner.ts:1360` feeds the Reviewer model to a
 * council call.
 *
 * Two conditions, because each catches a mistake the other misses:
 *
 *  1. DECLARED MODALITY — the model must accept text and return text.
 *     Catches a converter: `stepaudio-2.5-tts` is text-in but audio-out (it
 *     cannot return a debate turn), `stepaudio-2.5-asr` is audio-in but
 *     text-out (it cannot read the prompt). Absent → text-in/text-out, so a
 *     model that never declares the field is never disqualified by it.
 *
 *  2. A DECLARED-ZERO TEXT CONTEXT — `contextWindow === 0`.
 *     Catches a model whose declared modality includes text but which publishes
 *     no text budget in either direction. Both `stepaudio-2.5-chat` and
 *     `stepaudio-2.5-realtime` describe themselves as "Audio-and-text" in the
 *     catalog, so modality alone would readmit them, yet both publish
 *     `context_window: 0` / `max_output_tokens: 0` and the realtime row is
 *     served over a WebSocket API, not chat-completions.
 *
 *     Note this tests for an explicit ZERO, not for "greater than zero". Both
 *     signals follow the same rule: an ABSENT field never disqualifies, only a
 *     declared one does. `context_window` is required by the catalog schema so
 *     every real row states it, but a hand-built `ModelInfo` may omit it, and
 *     "not stated" must not mean "cannot do text".
 *
 * `max_output_tokens` is deliberately NOT part of the test: `step-3.7-flash` is
 * a live text model that publishes `max_output_tokens: 0`, so requiring it
 * would drop a model that works.
 *
 * Neither condition looks at the model id, the provider id, or `roles`. `roles`
 * is a routing concept — which jobs a model may be ASSIGNED — and 7 catalog
 * rows carry no roles while being perfectly good text models (5 opencode-go
 * LLMs, 2 zai vision models), so filtering on it would delete most of two
 * providers' fallback pools to fix a third provider's bug.
 */
export function canServeTextRequests(m: ModelInfo): boolean {
  const modalities = m.modalities;
  const acceptsText = modalities ? modalities.input.includes("text") : true;
  const emitsText = modalities ? modalities.output.includes("text") : true;
  const declaresNoTextBudget = typeof m.contextWindow === "number" && m.contextWindow <= 0;
  return acceptsText && emitsText && !declaresNoTextBudget;
}

/** True when the resolved model id can serve a text request. Unknown id → false. */
export function modelCanServeTextRequests(idOrAlias: string): boolean {
  const info = getModelInfo(idOrAlias);
  return info ? canServeTextRequests(info) : false;
}

function matchesTier(m: ModelInfo, tier: "fast" | "balanced" | "premium"): boolean {
  return m.tier === tier || m.routingTiers?.includes(tier) === true;
}

export function getModelByTier(tier: "fast" | "balanced" | "premium", preferProvider?: string): ModelInfo | undefined {
  if (preferProvider) {
    return MODELS.find(
      (m) => matchesTier(m, tier) && m.provider === preferProvider && isTierRoutable(m) && canServeTextRequests(m),
    );
  }
  return MODELS.find((m) => matchesTier(m, tier) && isTierRoutable(m) && canServeTextRequests(m));
}

/**
 * Every catalog model for a provider, including non-text ones.
 *
 * Use this only to LIST or address models (the config screens let a user
 * enable/disable an audio model, and `-m <id>` must still resolve one). Any
 * caller that is picking a model to SEND A PROMPT TO wants
 * `getTextModelsForProvider` instead.
 */
export function getModelsForProvider(providerId: string): ModelInfo[] {
  return MODELS.filter((m) => m.provider === providerId);
}

/**
 * The provider's models that can serve a text request, in catalog order.
 *
 * This is the accessor for every text-task selector — council panels, role
 * assignment, router fallbacks, GSD tier promotion. Filtering only removes
 * candidates that cannot answer a text prompt at all; relative order and every
 * text model's eligibility are untouched, so existing fallback behaviour for
 * text models is unchanged.
 */
export function getTextModelsForProvider(providerId: string): ModelInfo[] {
  return MODELS.filter((m) => m.provider === providerId && canServeTextRequests(m));
}

/**
 * Every provider the catalog actually ships models for, in catalog order.
 *
 * Callers that need "which providers can this build route to" must derive it
 * from here rather than keeping a hand-maintained list — a curated list goes
 * stale the moment a provider is added to catalog.json (that is how the model
 * picker ended up hiding openai, and with it the only way to sign in to it).
 */
export function getCatalogProviderIds(): string[] {
  const seen = new Set<string>();
  for (const m of MODELS) {
    if (m.provider) seen.add(m.provider);
  }
  return [...seen];
}

/**
 * Part E — does this model have NATIVE online web research (its own
 * web_search/browsing/Live-Search)? Missing flag → false (safe default per the
 * Kill #6 rule: never infer web capability from the provider).
 */
export function modelHasNativeWebResearch(idOrAlias: string): boolean {
  return getModelInfo(idOrAlias)?.nativeWebResearch === true;
}

/**
 * First catalog model with native web research (optionally constrained to a set
 * of reachable model ids). Used by the council research phase to route the
 * Researcher stance to a web-capable model. Returns undefined when none exist.
 */
export function getWebResearchModel(reachableIds?: ReadonlySet<string>): ModelInfo | undefined {
  return MODELS.find(
    (m) =>
      m.nativeWebResearch === true &&
      isTierRoutable(m) &&
      canServeTextRequests(m) &&
      (!reachableIds || reachableIds.has(m.id)),
  );
}

/**
 * Last-resort default model (e.g. `getCatalogDefaultModel` when no provider
 * default and no tier match exists). Text-only: this becomes the SESSION model,
 * so a non-text row here would 404 on the user's first prompt. Today's catalog
 * lists a text model first, which is why this was never hit — but that is
 * catalog ordering, not a guarantee.
 */
export function getFirstCatalogModel(): ModelInfo {
  const m = MODELS.find(canServeTextRequests);
  if (!m) throw new Error("No text-capable models in catalog. Check src/models/catalog.json or catalog endpoint.");
  return m;
}

export function getFirstCatalogProvider(): string {
  return getFirstCatalogModel().provider!;
}
