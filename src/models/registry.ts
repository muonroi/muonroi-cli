import type { ModelInfo, ReasoningEffort } from "../types";

// ---------------------------------------------------------------------------
// Canonical model catalog — Anthropic models only
// ---------------------------------------------------------------------------

const ALL_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export const MODELS: readonly ModelInfo[] = [
  {
    id: "claude-opus-4-7-20250415",
    name: "Claude Opus 4.7",
    contextWindow: 200_000,
    inputPrice: 15,
    outputPrice: 75,
    reasoning: true,
    description: "Most capable model — complex reasoning, coding, and analysis",
    aliases: ["claude-opus-4-7-latest"],
    supportsReasoningEffort: true,
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-sonnet-4-6-20250514",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    inputPrice: 3,
    outputPrice: 15,
    reasoning: true,
    description: "Best balance of speed and intelligence for everyday tasks",
    aliases: ["claude-sonnet-4-6-latest"],
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4,
    reasoning: false,
    description: "Fastest and most cost-effective for simple tasks",
    aliases: ["claude-haiku-4-5-latest"],
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    inputPrice: 3,
    outputPrice: 15,
    reasoning: false,
    description: "Previous-generation Sonnet — strong general performance",
    aliases: ["claude-3-5-sonnet-latest"],
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4,
    reasoning: false,
    description: "Previous-generation Haiku — fast and affordable",
    aliases: ["claude-3-5-haiku-latest"],
  },
] as const;

// ---------------------------------------------------------------------------
// O(1) lookup maps — built once at module load
// ---------------------------------------------------------------------------

/** Map from canonical ID → ModelInfo */
const byId = new Map<string, ModelInfo>(MODELS.map((m) => [m.id, m]));

/** Map from alias → canonical ID */
const aliasToCanonical = new Map<string, string>();
for (const m of MODELS) {
  if (m.aliases) {
    for (const alias of m.aliases) {
      aliasToCanonical.set(alias, m.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Return all canonical model IDs. */
export function getModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

/**
 * Look up a model by canonical ID or alias.
 * Returns `undefined` for unknown identifiers.
 */
export function getModelInfo(idOrAlias: string): ModelInfo | undefined {
  const canonical = aliasToCanonical.get(idOrAlias) ?? idOrAlias;
  return byId.get(canonical);
}

/**
 * Resolve an alias to its canonical ID.
 * Unknown identifiers pass through unchanged (supports custom/third-party models).
 */
export function normalizeModelId(idOrAlias: string): string {
  return aliasToCanonical.get(idOrAlias) ?? idOrAlias;
}

/**
 * Determine effective reasoning effort for a model + user request.
 * Returns `undefined` when effort is not applicable.
 */
export function getEffectiveReasoningEffort(
  modelId: string,
  requestedEffort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (requestedEffort === undefined) return undefined;
  const info = getModelInfo(modelId);
  if (!info?.reasoning) return undefined;
  return requestedEffort;
}

/**
 * Return the list of reasoning efforts supported by a model.
 * Returns an empty array for non-reasoning models or unknown IDs.
 */
export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] {
  const info = getModelInfo(modelId);
  if (!info?.reasoning) return [];
  return [...ALL_REASONING_EFFORTS];
}
