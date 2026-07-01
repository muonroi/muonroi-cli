/**
 * Routing decision orchestrator.
 *
 * Ladder: classifier hot -> warm -> cold -> fallback.
 * Cap precedence: ledger reservation checked before returning.
 * If cap breach detected, downgrade chain overrides classifier output (ROUTE-06).
 */

import { getDefaultEEClient } from "../ee/intercept.js";
import type { RouteOutcome } from "../ee/types.js";
import { getModelInfo, getModelsForProvider } from "../models/registry.js";
import { taskTypeToRole } from "../pil/task-tier-map.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { ALL_PROVIDER_IDS } from "../providers/types.js";
import { downgradeChain, emitDowngrade, getDowngradeChain } from "../usage/downgrade.js";
import { release, reserve } from "../usage/ledger.js";
import { midstreamPolicy } from "../usage/midstream.js";
import { CapBreachError } from "../usage/types.js";
import {
  getRoleModel,
  getRoutingPromoteMax,
  isCouncilMultiProviderPreferred,
  isProviderDisabled,
} from "../utils/settings.js";
import { classify } from "./classifier/index.js";
import { callColdRoute } from "./cold.js";
import { adjustPeakHourModel, getRoutedModelByTier } from "./peak-hour.js";
import { isInheritProvider } from "./provider-sentinel.js";
import { routerStore } from "./store.js";
import type { RouteDecision } from "./types.js";
import { callWarmRoute } from "./warm.js";

export interface DecideOpts {
  tenantId: string;
  cwd: string;
  threshold?: number;
  signal?: AbortSignal;
  defaultModel: string;
  defaultProvider: string;
  /**
   * Optional session id for audit logging. When provided, a `routing`
   * interaction event is emitted whenever the turn's routed model differs from
   * `defaultModel` (the stored session.model) — making per-turn overrides
   * observable instead of silent. Fixes the "session.model lie": a user on
   * flash could not see when the router silently promoted them to pro.
   */
  sessionId?: string;
  /** Override home directory for ledger (testing). */
  homeOverride?: string;
  /** PIL enrichment signals — forwarded to EE context. */
  pil?: {
    domain?: string | null;
    taskType?: string | null;
    confidence?: number;
    gsdPhase?: string | null;
    activeRunId?: string | null;
    recentTurnsSummary?: string | null;
    projectSize?: "small" | "medium" | "large" | null;
    filesTouched?: number;
    mode?: string | null;
    turnIndex?: number;
    messageCount?: number;
    compactionCount?: number;
    totalSavedTokens?: number;
    compactionSummary?: string | null;
  };
}

/** Default token estimates for cap projection (Phase 1). */
const ESTIMATE_INPUT = 4_000;
const ESTIMATE_OUTPUT = 1_000;

// ─── Routing decision cache (per session) ───────────────────────────────────

const ROUTE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

interface CachedRoute {
  decision: RouteDecision;
  timestamp: number;
}

const routeCache = new Map<string, CachedRoute>();

function routeCacheKey(pil?: DecideOpts["pil"]): string | null {
  if (!pil?.domain && !pil?.taskType) return null;
  return `${pil.domain ?? ""}|${pil.taskType ?? ""}|${pil.gsdPhase ?? ""}`;
}

function getCachedRoute(key: string): RouteDecision | null {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ROUTE_CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return entry.decision;
}

function setCachedRoute(key: string, decision: RouteDecision): void {
  routeCache.set(key, { decision, timestamp: Date.now() });
}

export function clearRouteCache(): void {
  routeCache.clear();
}

// ─── Rich context builder for EE routing ────────────────────────────────────

/**
 * Build a context object for EE routing calls (warm/cold).
 * Pulls projectSlug from cwd basename, phase from flow state if available,
 * and recently touched files if provided.
 */
function buildRouteContext(cwd: string, pil?: DecideOpts["pil"]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  const slug = cwd.split(/[\\/]/).filter(Boolean).pop();
  if (slug) ctx.projectSlug = slug;

  if (pil?.domain) ctx.domain = pil.domain;
  if (pil?.gsdPhase) ctx.phase = pil.gsdPhase;
  if (pil?.activeRunId) ctx.activeRun = pil.activeRunId;
  if (pil?.taskType && (pil.confidence ?? 0) > 0) {
    ctx.localRoute = { tier: pil.taskType, confidence: pil.confidence };
  }
  if (pil?.recentTurnsSummary) ctx.recentTurns = pil.recentTurnsSummary;
  if (pil?.projectSize) ctx.projectSize = pil.projectSize;
  if (pil?.filesTouched && pil.filesTouched > 0) ctx.filesTouched = pil.filesTouched;
  if (pil?.mode) ctx.mode = pil.mode;
  if (pil?.turnIndex !== undefined) ctx.turnIndex = pil.turnIndex;
  if (pil?.messageCount !== undefined) ctx.messageCount = pil.messageCount;
  if (pil?.compactionCount !== undefined) ctx.compactionCount = pil.compactionCount;
  if (pil?.totalSavedTokens !== undefined) ctx.totalSavedTokens = pil.totalSavedTokens;
  if (pil?.compactionSummary) ctx.compactionSummary = pil.compactionSummary;

  return ctx;
}

// ─── Disabled-provider guard: fallback providers ────────────────────────────

const FALLBACK_PROVIDERS: readonly ProviderId[] = ALL_PROVIDER_IDS;

/**
 * When the configured default provider is disabled by user settings, find
 * the first non-disabled provider and return its "balanced" tier model.
 * Returns the original defaults if no alternative is available.
 */
function resolveEffectiveDefaults(opts: DecideOpts): { model: string; provider: string } {
  if (!isProviderDisabled(opts.defaultProvider as ProviderId)) {
    return { model: opts.defaultModel, provider: opts.defaultProvider };
  }
  for (const p of FALLBACK_PROVIDERS) {
    if (!isProviderDisabled(p)) {
      const m = getRoutedModelByTier("balanced", p);
      // Guard: getModelByTier may return a model from a different provider
      // when the preferred provider has no model for the requested tier.
      if (m && m.provider === p) return { model: m.id, provider: m.provider ?? p };
      const models = getModelsForProvider(p);
      if (models.length > 0) return { model: models[0].id, provider: p };
    }
  }
  // All providers disabled — respect the user's original default anyway
  return { model: opts.defaultModel, provider: opts.defaultProvider };
}

/**
 * Pick a single model from a non-disabled provider for the given tier.
 * Returns undefined when the default provider is not disabled (no override needed).
 */
function resolveTierModel(
  tier: "fast" | "balanced" | "premium",
  defaultProvider: string,
): { id: string; provider: string } | undefined {
  if (!isProviderDisabled(defaultProvider as ProviderId)) {
    // Default provider is fine — use it
    return undefined;
  }
  for (const p of FALLBACK_PROVIDERS) {
    if (!isProviderDisabled(p)) {
      const m = getRoutedModelByTier(tier, p);
      // Guard: getModelByTier may return a model from a different provider
      // when the preferred provider has no model for the requested tier.
      if (m && m.provider === p) return { id: m.id, provider: m.provider ?? p };
      const models = getModelsForProvider(p);
      if (models.length > 0) return { id: models[0].id, provider: p };
    }
  }
  return undefined;
}

function applyPeakHourRoute(dec: RouteDecision): RouteDecision {
  const adj = adjustPeakHourModel(dec.model);
  if (!adj.adjusted) return dec;
  return {
    ...dec,
    model: adj.modelId,
    provider: adj.provider,
    reason: `${dec.reason}|${adj.reason}`,
  };
}

// ─── Provider constraint: never route to a provider the user lacks a key for ─

function constrainToProvider(decision: RouteDecision, opts: DecideOpts): RouteDecision {
  // Inherit-sentinel: warm path may emit an empty provider to signal
  // "trust upstream choice". Resolve the actual provider from the model ID
  // so disabled-provider checks still apply.
  if (isInheritProvider(decision.provider)) {
    const resolved = detectProviderForModel(decision.model);
    if (resolved && !isProviderDisabled(resolved as ProviderId)) return applyPeakHourRoute(decision);
    if (resolved && isProviderDisabled(resolved as ProviderId)) {
      return constrainToProvider({ ...decision, provider: resolved }, opts);
    }
    return applyPeakHourRoute(decision);
  }

  // Provider-only UX: the user enables N providers and pins one as default.
  // Routing rules:
  //   - decision.provider is enabled → keep it (router may switch across
  //     enabled providers when >1 is on).
  //   - decision.provider is disabled → constrain back to the default
  //     provider's tier model, falling back to defaultModel.
  //   - All providers disabled → leave the EE decision alone (caller will
  //     surface a config error elsewhere).
  const decisionDisabled = isProviderDisabled(decision.provider as ProviderId);
  if (!decisionDisabled) {
    return applyPeakHourRoute(decision);
  }

  if (isProviderDisabled(opts.defaultProvider as ProviderId)) {
    return {
      ...decision,
      reason: `${decision.reason}|provider-not-constrained(default-also-disabled)`,
    };
  }

  const sameProviderModel = getRoutedModelByTier(
    decision.tier === "hot" ? "fast" : decision.tier === "cold" ? "premium" : "balanced",
    opts.defaultProvider,
  );
  if (sameProviderModel && sameProviderModel.provider !== opts.defaultProvider) {
    return {
      ...decision,
      model: opts.defaultModel,
      provider: opts.defaultProvider,
      reason: `${decision.reason}|provider-constrained(forced-default)`,
    };
  }
  return applyPeakHourRoute({
    ...decision,
    model: sameProviderModel?.id ?? opts.defaultModel,
    provider: sameProviderModel?.provider ?? opts.defaultProvider,
    reason: `${decision.reason}|provider-constrained`,
  });
}

// ─── Route feedback (HTTP path) ─────────────────────────────────────────────

/**
 * Report a routing outcome back to EE via the HTTP client.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * @param taskHash - From the routing decision (routerStore.getState().taskHash)
 * @param outcome  - success | fail | retry | cancelled
 * @param duration - Turn duration in ms (optional)
 */
export function reportRouteOutcome(taskHash: string, outcome: RouteOutcome, duration?: number): void {
  const state = routerStore.getState();
  const dec = state.lastDecision;
  getDefaultEEClient().routeFeedback({
    taskHash,
    outcome,
    tier: dec?.tier ?? null,
    model: dec?.model ?? null,
    duration: duration ?? null,
  });
}

// ─── Tier-promotion cap (cost-ceiling guard) ───────────────────────────────

const TIER_RANK: Record<"fast" | "balanced" | "premium", number> = {
  fast: 0,
  balanced: 1,
  premium: 2,
};

/**
 * Enforce the user's tier-promotion ceiling. The session default model is the
 * cost ceiling: the router may downgrade per turn but may not silently promote
 * beyond `routingPromoteMax` (default "balanced"). See settings.ts.
 *
 * When the decision would promote, clamp down to the max allowed tier on the
 * SAME provider. If no same-provider model exists at the ceiling tier, fall
 * back to the session default model (the user's explicit pick). The clamp is
 * skipped for: the `"any"` opt-in, the role path (explicit user roleModels
 * config is itself the opt-in), cap-halt decisions, and provider-constrained
 * disabled-provider recoveries (those already move toward the default).
 */
function applyPromotionCap(dec: RouteDecision, defaultModel: string): RouteDecision {
  if (dec.model === "HALT" || dec.model === defaultModel) return dec;
  const cap = getRoutingPromoteMax();
  if (cap === "any") return dec;

  const capRank = cap === "off" ? null : TIER_RANK[cap]; // "balanced" → 1
  const defaultTier = getModelInfo(defaultModel)?.tier;
  // "off" means ceiling = the default model's own tier.
  const maxAllowedRank = capRank === null ? (defaultTier ? TIER_RANK[defaultTier] : 0) : capRank;

  const decInfo = getModelInfo(dec.model);
  const decTier = decInfo?.tier;
  if (!decTier || TIER_RANK[decTier] <= maxAllowedRank) return dec;

  // Promotion exceeds the ceiling — clamp DOWN to the max allowed tier on the
  // same provider. Walk down from the ceiling so we pick the highest permitted.
  const provider = decInfo?.provider ?? detectProviderForModel(dec.model);
  const targetTiers: ("fast" | "balanced" | "premium")[] =
    capRank === null
      ? defaultTier
        ? [defaultTier]
        : ["fast"]
      : maxAllowedRank >= 1
        ? (["balanced", "fast"] as const)
        : (["fast"] as const);
  for (const t of targetTiers) {
    if (TIER_RANK[t] > maxAllowedRank) continue;
    const m = getRoutedModelByTier(t, provider);
    if (m && m.provider === provider) {
      return {
        ...dec,
        model: m.id,
        reason: `${dec.reason} | promo-cap(${decTier}→${t})`,
      };
    }
  }
  // No cheaper model on the same provider — fall back to the session default.
  return {
    ...dec,
    model: defaultModel,
    reason: `${dec.reason} | promo-cap(${decTier}→default:${defaultModel})`,
  };
}

/**
 * Apply cap-check to a RouteDecision. Walks the downgrade chain if
 * the reservation would breach the cap. Returns the (possibly downgraded) decision.
 *
 * `opts` carries both the ledger homeOverride and the session defaultModel used
 * by the promotion cap. `exempt` skips the promotion cap — used only for the
 * role path, where the user's explicit roleModels config is itself the opt-in.
 */
async function capCheck(
  dec: RouteDecision,
  opts: { homeOverride?: string; defaultModel: string },
  exempt?: boolean,
): Promise<RouteDecision> {
  let current = exempt ? { ...dec } : applyPromotionCap({ ...dec }, opts.defaultModel);
  const homeOverride = opts.homeOverride;
  let attempts = 0;

  while (attempts++ < getDowngradeChain().length) {
    // If midstream policy already refuses, halt immediately
    if (midstreamPolicy.refuseNext()) {
      return {
        ...current,
        tier: "degraded",
        model: "HALT",
        reason: `${current.reason} | cap-halt`,
        cap_overridden: true,
      };
    }

    const tok = await reserve({
      provider: current.provider,
      model: current.model,
      estInputTokens: ESTIMATE_INPUT,
      estOutputTokens: ESTIMATE_OUTPUT,
      homeOverride,
    });

    if (tok instanceof CapBreachError) {
      const step = downgradeChain(current.model, midstreamPolicy.currentPct());
      emitDowngrade({
        fromModel: current.model,
        toModel: step.next,
        pct: midstreamPolicy.currentPct(),
        atMs: Date.now(),
      });

      if (step.isHalt) {
        midstreamPolicy.forceRefuseNext();
        return {
          ...current,
          tier: "degraded",
          model: "HALT",
          reason: `${current.reason} | cap-driven-downgrade-halt`,
          cap_overridden: true,
        };
      }

      current = {
        ...current,
        model: step.next,
        reason: `${current.reason} | cap-driven-downgrade`,
        cap_overridden: true,
      };
      continue;
    }

    // Reservation succeeded — release immediately (decide is dry-run for routing;
    // orchestrator re-reserves at actual stream time).
    await release(tok, homeOverride);
    return current;
  }

  return {
    ...current,
    model: "HALT",
    tier: "degraded",
    reason: "chain-exhausted",
    cap_overridden: true,
  };
}

/**
 * Decide whether a user-configured role→model override should be honored.
 *
 * A role model is honored only when its provider is usable in the current
 * session. Specifically a CROSS-provider role model (one whose provider differs
 * from the user's active `defaultProvider`) is honored ONLY when the user
 * explicitly opted into multi-provider council (`councilPreferMultiProvider`).
 *
 * Why: live observation showed a stale roleModel (left pointing at deepseek
 * after the user switched their active provider to openai) silently routed the
 * council/sprint role phases back to deepseek and failed mid-task with 402.
 * Honoring only same-provider role models (unless multi-provider is on) keeps
 * "I switched to provider X" meaning "everything uses X".
 */
export function shouldUseRoleModel(
  roleProvider: string,
  defaultProvider: string,
  opts: { providerDisabled: boolean; multiProviderPreferred: boolean },
): boolean {
  if (opts.providerDisabled) return false;
  if (roleProvider !== defaultProvider && !opts.multiProviderPreferred) return false;
  return true;
}

export async function decide(prompt: string, opts: DecideOpts): Promise<RouteDecision> {
  const cacheKey = routeCacheKey(opts.pil);
  if (cacheKey) {
    const cached = getCachedRoute(cacheKey);
    if (cached) {
      routerStore.setState({
        tier: cached.tier,
        lastDecision: cached,
        taskHash: cached.taskHash ?? null,
        source: cached.source ?? "cache",
      });
      return cached;
    }
  }

  const routeCtx = buildRouteContext(opts.cwd, opts.pil);

  // Step -1: Role-model override — user-configured role→model mapping takes priority
  const role = taskTypeToRole(opts.pil?.taskType ?? null);
  if (role) {
    const roleModelId = getRoleModel(role);
    if (roleModelId) {
      const _info = getModelInfo(roleModelId);
      const provider = detectProviderForModel(roleModelId);
      if (
        shouldUseRoleModel(provider, opts.defaultProvider, {
          providerDisabled: isProviderDisabled(provider as ProviderId),
          multiProviderPreferred: isCouncilMultiProviderPreferred(),
        })
      ) {
        const peak = adjustPeakHourModel(roleModelId);
        const d: RouteDecision = {
          tier: "hot",
          model: peak.modelId,
          provider: peak.provider,
          reason: peak.adjusted ? `role:${role}→${peak.modelId}|${peak.reason}` : `role:${role}→${roleModelId}`,
          source: "role",
        };
        const checked = await capCheck(d, opts, /* exempt */ true);
        routerStore.setState({ tier: checked.tier, lastDecision: checked, taskHash: null, source: "role" });
        if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
        return checked;
      }
    }
  }

  // Step 0: PIL context override — trust local classifier when confidence is high
  // Short/ambiguous messages ("fix it", "tiếp tục") can't be classified by text alone;
  // PIL has conversation context that brain LLM doesn't.
  const pilTier = opts.pil?.taskType as "fast" | "balanced" | "premium" | undefined;
  const pilConf = opts.pil?.confidence ?? 0;
  if (pilTier && pilConf >= 0.6) {
    // Use effective (non-disabled) provider when default is disabled
    const effective = resolveTierModel(pilTier, opts.defaultProvider);
    let tierModel = effective ?? getRoutedModelByTier(pilTier, opts.defaultProvider);
    // Guard: getModelByTier may cross to another provider when defaultProvider
    // has no model for the requested tier. If that cross-provider is disabled,
    // pin to the default model on the default provider instead.
    if (
      !effective &&
      tierModel &&
      tierModel.provider !== opts.defaultProvider &&
      isProviderDisabled(tierModel.provider as ProviderId)
    ) {
      tierModel = undefined;
    }
    const pilModel = tierModel?.id ?? opts.defaultModel;
    const peak = adjustPeakHourModel(pilModel);
    const d: RouteDecision = {
      tier: "hot",
      model: peak.modelId,
      provider: tierModel?.provider ?? peak.provider,
      reason: peak.adjusted
        ? `${effective ? `pil:${pilTier}(${pilConf.toFixed(2)})-rerouted(disabled-default)` : `pil:${pilTier}(${pilConf.toFixed(2)})`}|${peak.reason}`
        : effective
          ? `pil:${pilTier}(${pilConf.toFixed(2)})-rerouted(disabled-default)`
          : `pil:${pilTier}(${pilConf.toFixed(2)})`,
      confidence: pilConf,
      source: "pil",
    };
    const checked = await capCheck(d, opts);
    routerStore.setState({
      tier: checked.tier,
      lastDecision: checked,
      taskHash: checked.taskHash ?? null,
      source: checked.source ?? "pil",
    });
    if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
    return checked;
  }

  // Step 1: Hot-path local classifier
  const c = classify(prompt, opts.threshold ?? 0.55);
  if (c.tier === "hot") {
    // Use effective (non-disabled) provider when default is disabled
    const effective = c.tierHint ? resolveTierModel(c.tierHint, opts.defaultProvider) : undefined;
    let tierModel = effective ?? (c.tierHint ? getRoutedModelByTier(c.tierHint, opts.defaultProvider) : undefined);
    // Same guard as the PIL branch above: drop cross-provider fallback when
    // the cross-provider is disabled, so we don't switch to a provider the
    // user has turned off in the splash modal.
    if (
      !effective &&
      tierModel &&
      tierModel.provider !== opts.defaultProvider &&
      isProviderDisabled(tierModel.provider as ProviderId)
    ) {
      tierModel = undefined;
    }
    const hotModel = tierModel?.id ?? opts.defaultModel;
    const peak = adjustPeakHourModel(hotModel);
    const d: RouteDecision = {
      tier: "hot",
      model: peak.modelId,
      provider: tierModel?.provider ?? peak.provider,
      reason: peak.adjusted
        ? `${effective ? `${c.reason}-rerouted(disabled-default)` : c.reason}|${peak.reason}`
        : effective
          ? `${c.reason}-rerouted(disabled-default)`
          : c.reason,
      confidence: c.confidence,
    };
    const checked = await capCheck(d, opts);
    routerStore.setState({
      tier: checked.tier,
      lastDecision: checked,
      taskHash: checked.taskHash ?? null,
      source: checked.source ?? null,
    });
    if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
    return checked;
  }

  // Step 2: Warm path (EE /api/route-model, 250ms timeout)
  const w = await callWarmRoute(prompt, { ...opts, context: routeCtx });
  if (w) {
    const checked = await capCheck(constrainToProvider(w, opts), opts);
    routerStore.setState({
      tier: checked.tier,
      lastDecision: checked,
      taskHash: checked.taskHash ?? null,
      source: checked.source ?? null,
    });
    if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
    return checked;
  }

  // Step 3: Cold path (EE /api/cold-route, 1s timeout)
  const cd = await callColdRoute(prompt, { ...opts, context: routeCtx });
  if (cd) {
    const checked = await capCheck(constrainToProvider(cd, opts), opts);
    routerStore.setState({
      tier: "cold",
      lastDecision: checked,
      taskHash: checked.taskHash ?? null,
      source: checked.source ?? null,
    });
    if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
    return checked;
  }

  // Step 4: Final fallback when EE entirely unreachable
  const effective = resolveEffectiveDefaults(opts);
  const peak = adjustPeakHourModel(effective.model);
  const fallback: RouteDecision = {
    tier: routerStore.getState().degraded ? "degraded" : "hot",
    model: peak.modelId,
    provider: peak.provider,
    reason: peak.adjusted
      ? `${effective.provider !== opts.defaultProvider ? "fallback:ee-unreachable+rerouted(disabled-default)" : "fallback:ee-unreachable"}|${peak.reason}`
      : effective.provider !== opts.defaultProvider
        ? "fallback:ee-unreachable+rerouted(disabled-default)"
        : "fallback:ee-unreachable",
  };
  const checked = await capCheck(fallback, opts);
  routerStore.setState({
    lastDecision: checked,
    taskHash: null,
    source: null,
  });
  // Don't cache fallback decisions
  return checked;
}
