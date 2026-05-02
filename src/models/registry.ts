import type { ModelInfo, ReasoningEffort } from "../types";
import { createAdapter } from "../providers/adapter.js";
import { ALL_PROVIDER_IDS } from "../providers/adapter.js";
import type { ProviderId } from "../providers/types.js";

const ALL_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

// ---------------------------------------------------------------------------
// Dynamic model registry — populated by refreshModels() at boot
// ---------------------------------------------------------------------------

export let MODELS: ModelInfo[] = [];
export let isLoading = true;

/**
 * Fetch models from provider APIs. Called once at boot before any user interaction.
 * Providers without an API key are silently skipped.
 * On total failure (no providers reachable), MODELS stays empty — callers must handle.
 */
export async function refreshModels(
  configs: Partial<Record<ProviderId, { apiKey?: string; baseURL?: string; model?: string }>>,
): Promise<void> {
  isLoading = true;
  try {
    const allModels: ModelInfo[] = [];
    const seen = new Set<string>();

    for (const providerId of ALL_PROVIDER_IDS) {
      const providerConfig = configs[providerId];
      if (!providerConfig?.apiKey && providerId !== "ollama") continue;
      try {
        const adapter = createAdapter(providerId, {
          apiKey: providerConfig?.apiKey,
          baseURL: providerConfig?.baseURL,
          model: providerConfig?.model ?? "placeholder",
        });
        if (adapter.listModels) {
          const fetched = await adapter.listModels();
          for (const m of fetched) {
            if (!seen.has(m.id)) {
              allModels.push(m);
              seen.add(m.id);
            }
          }
        }
      } catch {
        // Provider unreachable — skip silently
      }
    }

    MODELS = allModels;
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
