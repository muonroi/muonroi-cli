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
  return MODELS.find((m) => m.id === idOrAlias || m.aliases?.includes(idOrAlias));
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

function matchesTier(m: ModelInfo, tier: "fast" | "balanced" | "premium"): boolean {
  return m.tier === tier || m.routingTiers?.includes(tier) === true;
}

export function getModelByTier(tier: "fast" | "balanced" | "premium", preferProvider?: string): ModelInfo | undefined {
  if (preferProvider) {
    return MODELS.find((m) => matchesTier(m, tier) && m.provider === preferProvider && isTierRoutable(m));
  }
  return MODELS.find((m) => matchesTier(m, tier) && isTierRoutable(m));
}

export function getModelsForProvider(providerId: string): ModelInfo[] {
  return MODELS.filter((m) => m.provider === providerId);
}

export function getFirstCatalogModel(): ModelInfo {
  const m = MODELS.find(() => true);
  if (!m) throw new Error("No models in catalog. Check src/models/catalog.json or catalog endpoint.");
  return m;
}

export function getFirstCatalogProvider(): string {
  return getFirstCatalogModel().provider!;
}
