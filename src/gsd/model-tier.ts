import { getModelByTier, getModelInfo, getModelsForProvider } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { BuiltinSubagentId, TaskRequest } from "../types/index.js";
import type { PlanPerspective, PlanPerspectiveId } from "./plan-council-prompts.js";

const TIER_RANK: Record<"fast" | "balanced" | "premium", number> = { fast: 0, balanced: 1, premium: 2 };

/**
 * GSD-only premium resolver — always picks the highest-tier model on the
 * session provider for plan-council / verify gates. Unlike
 * resolveLeaderModelDetailed, this intentionally promotes within-provider
 * for critical GSD stages.
 */
export function resolveGsdPremiumModel(sessionModelId: string): string {
  const providerId = detectProviderForModel(sessionModelId);
  let best: { id: string; tier: "fast" | "balanced" | "premium" } | undefined;
  for (const m of getModelsForProvider(providerId)) {
    if (m.tierRouting === false) continue;
    if (!m.tier) continue;
    if (!best || TIER_RANK[m.tier] > TIER_RANK[best.tier]) {
      best = { id: m.id, tier: m.tier };
    }
  }
  if (best) return best.id;
  const premium = getModelByTier("premium", providerId);
  if (premium) return premium.id;
  return sessionModelId;
}

/** Research perspectives ground against the codebase; others validate rigorously. */
export function resolveGsdPerspectiveAgent(id: PlanPerspectiveId): BuiltinSubagentId {
  return id === "research" ? "explore" : "verify";
}

export function buildGsdPerspectiveTaskRequest(
  prompt: string,
  perspective: PlanPerspective,
  sessionModelId: string,
  descriptionPrefix = "plan-council",
): TaskRequest {
  return {
    agent: resolveGsdPerspectiveAgent(perspective.id),
    prompt,
    description: `${descriptionPrefix}:${perspective.id}`,
    maxToolRounds: 4,
    modelId: resolveGsdPremiumModel(sessionModelId),
  };
}

export function tierOfModel(modelId: string): "fast" | "balanced" | "premium" | undefined {
  return getModelInfo(modelId)?.tier;
}
