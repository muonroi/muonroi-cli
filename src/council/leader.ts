import { resolveGsdPremiumModel } from "../gsd/model-tier.js";
import { getCatalogCouncilRouting, getModelInfo, getModelsForProvider } from "../models/registry.js";
import { getConfiguredProviders } from "../providers/keychain.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { getRoutedModelByTier } from "../router/peak-hour.js";
import { getRoleModel, getRoleModels, isProviderDisabled, type ModelRole } from "../utils/settings.js";

const TIER_RANK: Record<string, number> = { fast: 1, balanced: 2, premium: 3 };

function tierOf(modelId: string): "fast" | "balanced" | "premium" | undefined {
  const info = getModelInfo(modelId);
  return info?.tier;
}

// ─── Cost-aware sub-task routing ────────────────────────────────────────────

/**
 * Council sub-tasks that can be downshifted to a cheaper tier.
 * Maps each task to the LOWEST tier acceptable for that work; the resolver
 * picks the highest-quality reachable model that is still ≤ this tier.
 *
 * Keep this table in one place — it's the policy. Anything not listed here
 * MUST keep using the leader model (final synthesis, debate planning).
 */
export type CouncilSubTask =
  | "research_need" // 1-line JSON classifier
  | "evaluate_round" // JSON criteria status; needs decent judgement
  | "round_summary" // summarize 6 exchanges
  | "clarify_questions" // generate 3-5 questions
  | "spec_synthesis" // merge Q&A into ClarifiedSpec
  | "readiness_judge" // self-judge whether clarification is sufficient to debate
  | "effort_estimate" // batch story-point estimation for BacklogItems (P6)
  | "sprint_goal" // batch sprint goal generation for SprintPlan (P7)
  | "reporter_qa" // free-form Q&A from Discord reporter (P8)
  | "maintain_design" // P15 Mode C — single LLM design plan for maintenance task
  | "maintain_review" // P15 Mode C — single LLM review agent after edit
  | "pr_body"; // P16 Mode C — generate PR body from diff + task context (fast tier)

const SUB_TASK_TIER: Record<CouncilSubTask, "fast" | "balanced"> = {
  research_need: "fast",
  evaluate_round: "balanced",
  round_summary: "fast",
  clarify_questions: "balanced",
  spec_synthesis: "balanced",
  readiness_judge: "balanced",
  effort_estimate: "fast",
  sprint_goal: "fast",
  reporter_qa: "fast",
  maintain_design: "balanced",
  maintain_review: "fast",
  pr_body: "fast",
};

/**
 * Pick a cheaper model for a council sub-task on the leader's provider,
 * with fallback to the leader model itself when no cheaper model is
 * reachable / cataloged.
 *
 * Hard rule (matches resolveLeaderModelDetailed): never cross providers.
 * The leader's provider already has a key loaded, so this is zero-cost
 * to reach.
 *
 * Returns the leader model unchanged when:
 *   - cost-aware mode is disabled
 *   - leader is already at or below the target tier
 *   - no cataloged model on the leader's provider matches the target tier
 */
export function pickCouncilTaskModel(task: CouncilSubTask, leaderModelId: string, costAware: boolean): string {
  if (!costAware) return leaderModelId;

  const targetTier = SUB_TASK_TIER[task];
  const leaderTier = tierOf(leaderModelId);

  // Already at or below target — no benefit from switching.
  if (leaderTier && TIER_RANK[leaderTier] <= TIER_RANK[targetTier]) {
    return leaderModelId;
  }

  let leaderProvider: string;
  try {
    leaderProvider = detectProviderForModel(leaderModelId);
  } catch {
    return leaderModelId;
  }
  const candidate = getRoutedModelByTier(targetTier, leaderProvider);

  // Only accept a candidate that's on the same provider as the leader.
  // getModelByTier may fall back to "any provider" — reject that to avoid
  // billing surprises and silent key-misses.
  if (candidate && candidate.provider === leaderProvider) {
    return candidate.id;
  }
  return leaderModelId;
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
/**
 * A provider is reachable when it has an API key OR a stored OAuth token.
 * `loadKeyForProvider` only knows API keys (it throws for OAuth-only
 * providers), so without the OAuth fallback an OAuth-authed provider — e.g.
 * grok via xAI OAuth, or OpenAI/Google OAuth without an API key — was wrongly
 * treated as unreachable, making council bail "No reachable provider" even
 * though the model answers fine. VERIFY F15.
 */
async function isProviderReachable(provider: ProviderId): Promise<boolean> {
  // getConfiguredProviders() is the authoritative cred check — it unifies API
  // keys (keychain/env/settings) AND stored OAuth tokens across every provider
  // in the OAuth registry. The old loadKeyForProvider-only check saw API keys
  // but not OAuth, so an OAuth-only provider (e.g. grok via xAI OAuth) was
  // wrongly unreachable and council bailed "No reachable provider". VERIFY F15.
  const configured = await getConfiguredProviders();
  return configured.includes(provider);
}

/** Plan-council leader — always premium-tier within session provider (telemetry: plan-council). */
export async function resolvePlanCouncilLeader(sessionModelId: string): Promise<LeaderResolution> {
  const sessionProviderId = detectProviderForModel(sessionModelId);
  const sessionDisabled = isProviderDisabled(sessionProviderId as ProviderId);
  const sessionReachable = !sessionDisabled && (await isProviderReachable(sessionProviderId));
  if (!sessionReachable) {
    return { modelId: getRoleModel("leader") ?? sessionModelId };
  }

  const catalogLeader = getModelsForProvider(sessionProviderId).find((m) => m.roles?.includes("leader"));
  if (catalogLeader) {
    return { modelId: catalogLeader.id };
  }

  const premiumId = resolveGsdPremiumModel(sessionModelId);
  const sessionTier = tierOf(sessionModelId);
  const premiumTier = tierOf(premiumId);
  if (premiumId !== sessionModelId && premiumTier && sessionTier && TIER_RANK[premiumTier] > TIER_RANK[sessionTier]) {
    return { modelId: premiumId, promotedFrom: { modelId: sessionModelId, tier: sessionTier } };
  }
  if (premiumId !== sessionModelId) {
    return { modelId: premiumId, defaulted: true };
  }
  return { modelId: sessionModelId, defaulted: true };
}

export async function resolveLeaderModelDetailed(sessionModelId: string): Promise<LeaderResolution> {
  const sessionProviderId = detectProviderForModel(sessionModelId);
  const configured = getRoleModel("leader");
  const configuredProvider = configured ? detectProviderForModel(configured) : undefined;
  const configuredTier = configured ? tierOf(configured) : undefined;

  const sessionDisabled = isProviderDisabled(sessionProviderId as ProviderId);
  const sessionReachable = !sessionDisabled && (await isProviderReachable(sessionProviderId));
  if (!sessionReachable) {
    return { modelId: configured ?? sessionModelId };
  }

  // 1. If not manually configured, and session provider has a catalog model with "leader" role, use it!
  if (!configured) {
    const catalogLeader = getModelsForProvider(sessionProviderId).find((m) => m.roles?.includes("leader"));
    if (catalogLeader) {
      return { modelId: catalogLeader.id };
    }
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

  // No usable configured leader — use the session model itself. We intentionally
  // do NOT silently promote to the highest-tier model on the provider: the
  // user's account/key may not have access to that tier (e.g. SiliconFlow Pro),
  // which would cause 401s on every leader call. Tier-upgrade is a deliberate
  // choice — opt in by setting roleModels.leader in config.
  return { modelId: sessionModelId, defaulted: true };
}

/** Back-compat sync wrapper. Returns the modelId only; no reachability check. */
export function resolveLeaderModel(sessionModelId: string): string {
  const configured = getRoleModel("leader");
  if (configured) return configured;
  const sessionProviderId = detectProviderForModel(sessionModelId);
  const catalogLeader = getModelsForProvider(sessionProviderId).find((m) => m.roles?.includes("leader"));
  if (catalogLeader) return catalogLeader.id;
  // See resolveLeaderModelDetailed for why we no longer silently upgrade to
  // the premium tier on the session provider (user may not have access).
  return sessionModelId;
}

export function hasMultiProviderConfig(roleModels: Partial<Record<ModelRole, string>>): boolean {
  const providers = new Set<string>();
  for (const modelId of Object.values(roleModels)) {
    if (modelId) providers.add(detectProviderForModel(modelId));
  }
  return providers.size >= 2;
}

/**
 * Count debate roles available for auto-council gating.
 * Uses explicit roleModels when ≥2 configured; otherwise catalog council slots.
 */
export function getEffectiveCouncilRoleCount(): number {
  const explicit = Object.values(getRoleModels()).filter(Boolean).length;
  if (explicit >= 2) return explicit;
  const catalog = getCatalogCouncilRouting();
  if (catalog?.participants?.length && catalog.participants.length >= 2) {
    return catalog.participants.length;
  }
  return explicit;
}

async function resolveCatalogCouncilParticipants(): Promise<Array<{ role: ModelRole; model: string }>> {
  const config = getCatalogCouncilRouting();
  if (!config?.participants?.length) return [];

  const candidates: Array<{ role: ModelRole; model: string }> = [];
  const usedModels = new Set<string>();

  for (const slot of config.participants) {
    const role = slot.role;
    const provider = slot.provider as ProviderId;
    if (isProviderDisabled(provider)) continue;
    if (!(await isProviderReachable(provider))) continue;

    let modelId: string | undefined;
    if (slot.model_id) {
      const info = getModelInfo(slot.model_id);
      if (info?.provider === provider) modelId = slot.model_id;
    }
    if (!modelId && slot.tier) {
      const m = getRoutedModelByTier(slot.tier, provider);
      if (m?.provider === provider) modelId = m.id;
    }
    if (!modelId) {
      const models = getModelsForProvider(provider);
      const routable = models.find((m) => m.tierRouting !== false);
      modelId = routable?.id ?? models[0]?.id;
    }
    if (!modelId || usedModels.has(modelId)) continue;

    candidates.push({ role, model: modelId });
    usedModels.add(modelId);
  }

  return candidates.length >= 2 ? candidates : [];
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
      const provider = detectProviderForModel(modelId);
      if (isProviderDisabled(provider as ProviderId)) continue;
      const canReach = await isProviderReachable(provider);
      if (canReach) candidates.push({ role, model: modelId });
    }
    if (candidates.length >= 2) return candidates;
  }

  // Catalog-defined multi-provider lineup (default for deepseek+zai+opencode-go+xai stack).
  if (preferMultiProvider) {
    const catalogCandidates = await resolveCatalogCouncilParticipants();
    if (catalogCandidates.length >= 2) return catalogCandidates;
  }

  const mainProviderId = detectProviderForModel(sessionModelId);
  // Skip same-provider resolution if the provider is disabled
  if (!isProviderDisabled(mainProviderId as ProviderId)) {
    const sameCandidates = await resolveSameProviderCandidates(mainProviderId, sessionModelId, ALL_ROLES);
    if (sameCandidates.length >= 2) return sameCandidates;
  }

  const providerDisabled = isProviderDisabled(detectProviderForModel(sessionModelId) as ProviderId);
  const canReach = !providerDisabled && (await isProviderReachable(detectProviderForModel(sessionModelId)));
  if (canReach) {
    return ALL_ROLES.map((role) => ({ role, model: sessionModelId }));
  }

  return [];
}

/** A model the leader may pick for a task-aware debate panel (U3). */
export interface CouncilCandidate {
  model: string;
  tier?: string;
  provider?: string;
  roles?: string[];
  description: string;
}

/**
 * Build the pool of models the leader may choose from when assembling a
 * task-aware panel (U3). Seeded with the default roster (guaranteed reachable),
 * then expanded with other reachable, routable models on the same providers.
 * Capped so the selection prompt stays bounded. Never throws — a provider probe
 * failure simply yields a smaller pool, and the caller falls back to the roster.
 */
export async function buildCouncilCandidatePool(
  defaultRoster: Array<{ role: ModelRole; model: string }>,
): Promise<CouncilCandidate[]> {
  const byId = new Map<string, CouncilCandidate>();
  const add = (modelId: string) => {
    if (!modelId || byId.has(modelId)) return;
    const info = getModelInfo(modelId);
    byId.set(modelId, {
      model: modelId,
      tier: info?.tier,
      provider: info?.provider ?? detectProviderForModel(modelId),
      roles: info?.roles,
      description: info?.description ?? "",
    });
  };
  for (const r of defaultRoster) add(r.model);

  const providers = new Set<ProviderId>();
  for (const r of defaultRoster) providers.add(detectProviderForModel(r.model) as ProviderId);
  for (const provider of providers) {
    if (byId.size >= 8) break;
    if (isProviderDisabled(provider)) continue;
    if (!(await isProviderReachable(provider))) continue;
    for (const m of getModelsForProvider(provider)) {
      if (m.tierRouting === false) continue;
      add(m.id);
      if (byId.size >= 8) break;
    }
  }
  return [...byId.values()];
}

async function resolveSameProviderCandidates(
  providerId: ProviderId,
  sessionModelId: string,
  roles: ModelRole[],
): Promise<Array<{ role: ModelRole; model: string }>> {
  if (isProviderDisabled(providerId)) return [];
  const canReach = await isProviderReachable(providerId);
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
    let picked = providerModels.find((m) => m.roles?.includes(role) && !usedModels.has(m.id));
    if (!picked) {
      const prefs = tierPreference[role] ?? ["balanced", "fast", "premium"];
      picked = providerModels.find((m) => prefs.some((t) => m.tier === t) && !usedModels.has(m.id));
    }
    if (!picked) picked = providerModels.find((m) => !usedModels.has(m.id));
    if (!picked) picked = providerModels[0];

    candidates.push({ role, model: picked.id });
    usedModels.add(picked.id);
  }

  return candidates;
}
