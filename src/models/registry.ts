import type { ModelInfo, ReasoningEffort } from "../types";
import { fetchCatalog, catalogModelToModelInfo } from "./catalog-client.js";

const ALL_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

// ---------------------------------------------------------------------------
// Centralized model registry — populated by loadCatalog() at boot
// ---------------------------------------------------------------------------

export let MODELS: ModelInfo[] = [];
export let isLoading = true;

/**
 * Load models from centralized catalog (CP endpoint with static fallback).
 * Called once at boot. No provider API keys needed.
 */
export async function loadCatalog(): Promise<void> {
  isLoading = true;
  try {
    const catalog = await fetchCatalog();
    MODELS = catalog.map(catalogModelToModelInfo);
  } catch {
    // On total failure, MODELS stays empty — callers must handle
  } finally {
    isLoading = false;
  }
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
