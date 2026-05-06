import { getRoleModel, getRoleModels, type ModelRole } from "../utils/settings.js";
import { getModelByTier, getModelsForProvider } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";

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
