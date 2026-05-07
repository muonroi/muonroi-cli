import { getRoleModel, getRoleModels, type ModelRole } from "../utils/settings.js";
import { getModelByTier, getModelInfo, getModelsForProvider } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";

const TIER_RANK: Record<string, number> = { fast: 1, balanced: 2, premium: 3 };

function tierOf(modelId: string): "fast" | "balanced" | "premium" | undefined {
  const info = getModelInfo(modelId);
  return info?.tier;
}

export interface LeaderResolution {
  modelId: string;
  /** Set when configured leader was auto-promoted to a higher tier. */
  promotedFrom?: { modelId: string; tier?: string };
  /** Set when no configured leader existed and one was picked by tier. */
  defaulted?: boolean;
}

/**
 * Resolve the leader model with quality-aware promotion.
 *
 * Hard rule: stay within the SESSION model's provider — don't switch providers
 * (different billing, surprise cost). We only upgrade tier within the same
 * provider that the user is already running.
 *
 * Priority:
 *   1. Find the highest-tier reachable model from the session provider's
 *      catalog (registry + any configured role-models on that provider).
 *   2. If a configured `roleModels.leader` exists AND is on the session
 *      provider, use it unless a strictly higher-tier model exists on the
 *      same provider — then auto-promote with a note.
 *   3. If configured leader is on a DIFFERENT provider, ignore it and pick
 *      from the session provider.
 *   4. Fall back to the session model itself.
 */
export async function resolveLeaderModelDetailed(sessionModelId: string): Promise<LeaderResolution> {
  const sessionProviderId = detectProviderForModel(sessionModelId);
  const configured = getRoleModel("leader");
  const configuredProvider = configured ? detectProviderForModel(configured) : undefined;
  const configuredTier = configured ? tierOf(configured) : undefined;

  const sessionReachable = await loadKeyForProvider(sessionProviderId)
    .then(() => true)
    .catch(() => false);
  if (!sessionReachable) {
    return { modelId: configured ?? sessionModelId };
  }

  // Build candidate set ON THE SESSION PROVIDER ONLY.
  const candidates = new Map<string, "fast" | "balanced" | "premium">();
  for (const m of getModelsForProvider(sessionProviderId)) {
    if (m.tier) candidates.set(m.id, m.tier);
  }
  // Include any configured role-models that happen to be on session provider.
  for (const id of Object.values(getRoleModels())) {
    if (!id) continue;
    if (detectProviderForModel(id) !== sessionProviderId) continue;
    const t = tierOf(id);
    if (t) candidates.set(id, t);
  }
  const sessionTier = tierOf(sessionModelId);
  if (sessionTier) candidates.set(sessionModelId, sessionTier);

  let best: { id: string; tier: "fast" | "balanced" | "premium" } | undefined;
  for (const [id, tier] of candidates) {
    if (!best || TIER_RANK[tier] > TIER_RANK[best.tier]) {
      best = { id, tier };
    }
  }

  // Configured leader on the same provider → respect it unless we can promote.
  if (configured && configuredProvider === sessionProviderId) {
    if (!best || !configuredTier || TIER_RANK[best.tier] <= TIER_RANK[configuredTier]) {
      return { modelId: configured };
    }
    return {
      modelId: best.id,
      promotedFrom: { modelId: configured, tier: configuredTier },
    };
  }

  // Configured leader on different provider — ignore and pick from session provider.
  if (configured && configuredProvider !== sessionProviderId && best) {
    return {
      modelId: best.id,
      promotedFrom: { modelId: configured, tier: configuredTier },
    };
  }

  // No usable configured leader — pick best from session provider.
  if (best) return { modelId: best.id, defaulted: true };
  return { modelId: sessionModelId, defaulted: true };
}

/** Back-compat sync wrapper. Returns the modelId only; no reachability check. */
export function resolveLeaderModel(sessionModelId: string): string {
  const configured = getRoleModel("leader");
  if (configured) return configured;
  const providerId = detectProviderForModel(sessionModelId);
  const premium = getModelByTier("premium", providerId);
  if (premium) return premium.id;
  const anyPremium = getModelByTier("premium");
  if (anyPremium) return anyPremium.id;
  return sessionModelId;
}

export function hasMultiProviderConfig(roleModels: Partial<Record<ModelRole, string>>): boolean {
  const providers = new Set<string>();
  for (const modelId of Object.values(roleModels)) {
    if (modelId) providers.add(detectProviderForModel(modelId));
  }
  return providers.size >= 2;
}

export async function resolveParticipants(
  sessionModelId: string,
  preferMultiProvider: boolean,
): Promise<Array<{ role: ModelRole; model: string }>> {
  const ALL_ROLES: ModelRole[] = ["implement", "verify", "research"];
  const candidates: Array<{ role: ModelRole; model: string }> = [];
  const configuredRoleModels = getRoleModels();
  const hasExplicit = hasMultiProviderConfig(configuredRoleModels);

  if (hasExplicit && preferMultiProvider) {
    for (const role of ALL_ROLES) {
      const modelId = getRoleModel(role);
      if (!modelId) continue;
      const canReach = await loadKeyForProvider(detectProviderForModel(modelId))
        .then(() => true)
        .catch(() => false);
      if (canReach) candidates.push({ role, model: modelId });
    }
    if (candidates.length >= 2) return candidates;
  }

  const mainProviderId = detectProviderForModel(sessionModelId);
  const sameCandidates = await resolveSameProviderCandidates(mainProviderId, sessionModelId, ALL_ROLES);
  if (sameCandidates.length >= 2) return sameCandidates;

  const canReach = await loadKeyForProvider(detectProviderForModel(sessionModelId))
    .then(() => true)
    .catch(() => false);
  if (canReach) {
    return ALL_ROLES.map((role) => ({ role, model: sessionModelId }));
  }

  return [];
}

async function resolveSameProviderCandidates(
  providerId: ProviderId,
  sessionModelId: string,
  roles: ModelRole[],
): Promise<Array<{ role: ModelRole; model: string }>> {
  const canReach = await loadKeyForProvider(providerId)
    .then(() => true)
    .catch(() => false);
  if (!canReach) return [];

  const providerModels = getModelsForProvider(providerId);
  if (providerModels.length === 0) {
    return roles.map((role) => ({ role, model: sessionModelId }));
  }

  const tierPreference: Record<string, Array<"fast" | "balanced" | "premium">> = {
    implement: ["balanced", "premium", "fast"],
    verify: ["premium", "balanced", "fast"],
    research: ["fast", "balanced", "premium"],
  };

  const usedModels = new Set<string>();
  const candidates: Array<{ role: ModelRole; model: string }> = [];

  for (const role of roles) {
    const prefs = tierPreference[role] ?? ["balanced", "fast", "premium"];
    let picked = providerModels.find((m) => prefs.some((t) => m.tier === t) && !usedModels.has(m.id));
    if (!picked) picked = providerModels.find((m) => !usedModels.has(m.id));
    if (!picked) picked = providerModels[0];

    candidates.push({ role, model: picked.id });
    usedModels.add(picked.id);
  }

  return candidates;
}
