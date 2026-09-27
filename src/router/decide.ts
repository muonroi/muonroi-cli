/**
 * Routing decision orchestrator.
 *
 * Ladder: classifier hot -> warm -> cold -> fallback.
 * Cap precedence: ledger reservation checked before returning.
 * If cap breach detected, downgrade chain overrides classifier output (ROUTE-06).
 */

import { createHash } from "node:crypto";
import { getDefaultEEClient } from "../ee/intercept.js";
import type { RouteOutcome } from "../ee/types.js";
import { getModelInfo, getTextModelsForProvider } from "../models/registry.js";
import { type EETier, taskTypeToRole, taskTypeToTier } from "../pil/task-tier-map.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { ALL_PROVIDER_IDS } from "../providers/types.js";
import { downgradeChain, emitDowngrade, getDowngradeChain } from "../usage/downgrade.js";
import { release, reserve } from "../usage/ledger.js";
import { midstreamPolicy } from "../usage/midstream.js";
import { CapBreachError } from "../usage/types.js";
import { isIdealRunUnlimited } from "../utils/ideal-run-scope.js";
import {
  getRoleModel,
  getRoutingDemoteMin,
  getRoutingPromoteMax,
  isCouncilMultiProviderPreferred,
  isProviderDisabled,
} from "../utils/settings.js";
import { classify } from "./classifier/index.js";
import { adjustPeakHourModel, getRoutedModelByTier } from "./peak-hour.js";
import { routerStore } from "./store.js";
import type { RouteDecision } from "./types.js";

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
  /**
   * Round-2 fix — a project-level `.muonroi-cli/settings.json` model pin
   * (`isModelPinnedByProject()`) for the MAIN conversation turn. When set,
   * `decide()` skips the classifier ladder (role/PIL/hot/warm/cold) entirely
   * — the pin already decided the model choice — but STILL runs the SAME
   * cap/budget reservation + downgrade-chain/halt check (`capCheck`) any
   * other decision goes through. A cap breach on a pinned turn therefore
   * still downgrades along that model's own chain, or halts, exactly as an
   * unpinned turn would; only the free CHOICE of model is superseded by the
   * pin. Bypasses the route cache too, so a cap state that changed since the
   * last cached decision is always seen fresh.
   */
  forcedModel?: string;
  /**
   * Outcomes of similar past tasks from EE `/api/route-history`, fetched by the
   * caller alongside intent classification. null/absent means no advice.
   */
  history?: RouteHistoryAdvice | null;
  /** PIL enrichment signals. */
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

/**
 * Cache key for a routing decision.
 *
 * MUST include the active default model + provider. They are inputs to every
 * branch below (`resolveTierModel`/`getRoutedModelByTier` take `defaultProvider`,
 * and the fallthrough returns `opts.defaultModel`), so a key without them
 * replays a decision computed for a DIFFERENT active model.
 *
 * Session 3f998bfef7db: the user hit a provider-side 400 on gpt-5.4 and switched
 * provider to escape it. interaction_logs then shows
 *   id 286 @03:39:53 routing/default   default=gpt-5.4           → gpt-5.4
 *   id 293 @03:40:23 routing/promoted  default=deepseek-v4-flash → gpt-5.4
 *   id 392 @03:51:34 routing/promoted  default=deepseek-v4-flash → gpt-5.4
 * all three carrying the byte-identical reason "pil:debug(0.75)" — a replayed
 * decision, not three independent ones. The switch was silently undone and the
 * user was sent straight back to the provider they had just abandoned.
 * (`clearRouteCache` exists but has no production caller, so nothing else
 * invalidated it.)
 */
function routeCacheKey(
  pil?: DecideOpts["pil"],
  defaultModel?: string,
  defaultProvider?: string,
  evidence?: string,
): string | null {
  if (!pil?.domain && !pil?.taskType) return null;
  // The tier also depends on route history and the previous turn's outcome; a key
  // without them would replay a pre-failure decision and never escalate.
  return `${pil.domain ?? ""}|${pil.taskType ?? ""}|${pil.gsdPhase ?? ""}|${defaultModel ?? ""}|${defaultProvider ?? ""}|${evidence ?? ""}`;
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
      const models = getTextModelsForProvider(p);
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
      const models = getTextModelsForProvider(p);
      if (models.length > 0) return { id: models[0].id, provider: p };
    }
  }
  return undefined;
}

const TIER_ORDER: ReadonlyArray<EETier> = ["fast", "balanced", "premium"];

export interface RouteHistoryAdvice {
  /** One tier above the highest tier a similar task failed on. */
  floorTier: EETier | null;
  /** The lowest tier a similar task succeeded on with no failure at or above it. */
  suggestedTier: EETier | null;
}

const tierRank = (t: EETier): number => TIER_ORDER.indexOf(t);

/**
 * The tier a turn is served at: the classifier's base tier moved by evidence.
 *
 * Down: a similar task succeeded on a lower tier before (EE route history), bounded
 * below by `routingDemoteMin`. "off" keeps the session model as the floor, which is
 * what this used to enforce unconditionally; the log then showed a chitchat turn
 * lifted to premium only for the promotion cap to cut it back to balanced.
 * Up: a similar task failed on this tier, or the previous turn failed or was
 * cancelled. The ceiling stays with `applyPromotionCap` inside capCheck.
 */
export function resolveTurnTier(
  base: EETier,
  opts: Pick<DecideOpts, "defaultModel" | "history">,
  recentFailures: number,
): { tier: EETier; notes: string[] } {
  const notes: string[] = [];
  let tier = base;
  const history = opts.history;
  if (history?.suggestedTier && tierRank(history.suggestedTier) < tierRank(tier)) {
    tier = history.suggestedTier;
    notes.push(`history-down→${tier}`);
  }
  if (history?.floorTier && tierRank(history.floorTier) > tierRank(tier)) {
    tier = history.floorTier;
    notes.push(`history-floor→${tier}`);
  }
  if (recentFailures > 0 && tierRank(tier) < TIER_ORDER.length - 1) {
    tier = TIER_ORDER[tierRank(tier) + 1];
    notes.push(`escalate:prev-fail×${recentFailures}→${tier}`);
  }
  const defaultTier = getModelInfo(opts.defaultModel)?.tier as EETier | undefined;
  if (defaultTier && tierRank(tier) < tierRank(defaultTier)) {
    const min = getRoutingDemoteMin();
    const floor = min === "off" || tierRank(min) > tierRank(defaultTier) ? defaultTier : min;
    if (tierRank(tier) < tierRank(floor)) {
      tier = floor;
      notes.push(`demote-floor→${tier}`);
    }
  }
  return { tier, notes };
}

const withNotes = (reason: string, notes: string[]): string =>
  notes.length ? `${reason}[${notes.join(",")}]` : reason;

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
  // A failed or cancelled turn escalates the next decision one tier (resolveTurnTier).
  const failed = outcome === "fail" || outcome === "cancelled";
  routerStore.setState({ recentFailures: failed ? state.recentFailures + 1 : 0 });
  getDefaultEEClient().routeFeedback({
    taskHash,
    outcome,
    // The catalog tier EE learns in (fast/balanced/premium), not the router's
    // hot/warm/cold ladder position, which is what `dec.tier` holds.
    tier: state.eeTier,
    model: dec?.model ?? null,
    duration: duration ?? null,
    ...(state.taskText ? { task: state.taskText } : {}),
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
  const defaultRank = defaultTier ? TIER_RANK[defaultTier] : 0;
  // "off" means ceiling = the default model's own tier. A cap below the session
  // model is not a ceiling on promotion: serving the user's own tier promotes
  // nothing, and clamping it cut a premium session down to balanced.
  const maxAllowedRank = capRank === null ? defaultRank : Math.max(capRank, defaultRank);

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
  // `/ideal` has no spend limit (user decision): a turn it drives is never
  // downgraded or halted on the monthly cap. The reservation below is a dry run
  // (reserved and released in the same call), so skipping it leaks nothing, and
  // real spend is still recorded by the usage pipeline. Normal chat is unchanged.
  if (isIdealRunUnlimited()) return current;
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

/** Same prefix and hash EE's router uses, so both sides name a task the same way. */
const TASK_HASH_CHARS = 500;
export function computeTaskHash(prompt: string): string {
  return createHash("sha256").update(prompt.slice(0, TASK_HASH_CHARS)).digest("hex").slice(0, 16);
}

/**
 * Route one turn. Every decision carries a taskHash and records the task text and
 * the tier actually served, so `reportRouteOutcome` can send EE a learnable outcome.
 * Before this, only EE warm/cold decisions carried a hash and neither ever arrived:
 * 19 routed turns, 0 hashes, and EE held 263 decisions with 0 outcomes.
 */
export async function decide(prompt: string, opts: DecideOpts): Promise<RouteDecision> {
  const decision = await decideModel(prompt, opts);
  const taskHash = computeTaskHash(prompt);
  const served = decision.model === "HALT" ? undefined : (getModelInfo(decision.model)?.tier as EETier | undefined);
  const out: RouteDecision = { ...decision, taskHash };
  routerStore.setState({
    lastDecision: out,
    taskHash,
    taskText: prompt.slice(0, TASK_HASH_CHARS),
    eeTier: served ?? null,
  });
  return out;
}

async function decideModel(prompt: string, opts: DecideOpts): Promise<RouteDecision> {
  const recentFailures = routerStore.getState().recentFailures;
  // Round-2 fix — a project model pin overrides ONLY the model CHOICE below
  // (skips role/PIL/hot/warm/cold classification entirely); the cap/budget
  // reservation + downgrade-chain/halt check still runs against the pinned
  // model, exactly like every other decision path — see forcedModel's doc
  // comment on DecideOpts. No cache (a fresh cap check every call), no
  // promotion-cap check (exempt: true — moot anyway, dec.model === defaultModel).
  if (opts.forcedModel) {
    const provider = detectProviderForModel(opts.forcedModel) ?? opts.defaultProvider;
    const d: RouteDecision = {
      tier: "hot",
      model: opts.forcedModel,
      provider,
      reason: "project-model-pin",
      source: "project-pin",
    };
    const checked = await capCheck(d, { homeOverride: opts.homeOverride, defaultModel: opts.forcedModel }, true);
    routerStore.setState({
      tier: checked.tier,
      lastDecision: checked,
      taskHash: checked.taskHash ?? null,
      source: checked.source ?? "project-pin",
    });
    return checked;
  }

  const cacheKey = routeCacheKey(
    opts.pil,
    opts.defaultModel,
    opts.defaultProvider,
    `${recentFailures}|${opts.history?.floorTier ?? ""}|${opts.history?.suggestedTier ?? ""}`,
  );
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
  //
  // taskType is NOT a tier. It used to be cast straight to the tier union
  // (`opts.pil.taskType as "fast" | "balanced" | "premium"`), a cast that can
  // never hold: `matchesTier` compares against `debug`/`analyze`/`plan`/… and
  // never matches, so `getModelByTier` returned undefined and this entire branch
  // silently fell through to `opts.defaultModel` — a no-op that only populated
  // the route cache. `taskTypeToTier` is the canonical map (src/pil/task-tier-map.ts),
  // already used for the role lookup in Step -1 above.
  const pilTaskType = opts.pil?.taskType ?? null;
  const pilResolved = pilTaskType ? resolveTurnTier(taskTypeToTier(pilTaskType), opts, recentFailures) : undefined;
  const pilTier = pilResolved?.tier;
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
    // Keep BOTH the taskType and the tier it mapped to. Forensics on
    // interaction_logs.reason must tell "classified debug" apart from "routed at
    // balanced"; the old `pil:debug(0.75)` conflated them, which is why three
    // replayed cache hits were indistinguishable from three fresh decisions.
    const pilReasonBase = withNotes(`pil:${pilTaskType}→${pilTier}(${pilConf.toFixed(2)})`, pilResolved?.notes ?? []);
    const d: RouteDecision = {
      tier: "hot",
      model: peak.modelId,
      provider: tierModel?.provider ?? peak.provider,
      reason: peak.adjusted
        ? `${effective ? `${pilReasonBase}-rerouted(disabled-default)` : pilReasonBase}|${peak.reason}`
        : effective
          ? `${pilReasonBase}-rerouted(disabled-default)`
          : pilReasonBase,
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
    const hotResolved = c.tierHint ? resolveTurnTier(c.tierHint, opts, recentFailures) : undefined;
    const hotTier = hotResolved?.tier;
    // Use effective (non-disabled) provider when default is disabled
    const effective = hotTier ? resolveTierModel(hotTier, opts.defaultProvider) : undefined;
    let tierModel = effective ?? (hotTier ? getRoutedModelByTier(hotTier, opts.defaultProvider) : undefined);
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
    const hotReason = withNotes(c.reason, hotResolved?.notes ?? []);
    const d: RouteDecision = {
      tier: "hot",
      model: peak.modelId,
      provider: tierModel?.provider ?? peak.provider,
      reason: peak.adjusted
        ? `${effective ? `${hotReason}-rerouted(disabled-default)` : hotReason}|${peak.reason}`
        : effective
          ? `${hotReason}-rerouted(disabled-default)`
          : hotReason,
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

  // Step 2: no classifier verdict. Start from the session model's tier and let the
  // evidence (route history, a failed previous turn) move it. This replaces the EE
  // warm/cold calls: /api/route-model answered in ~4.8s against a 250ms budget and
  // /api/cold-route does not exist, so neither ever returned a decision.
  const defaultTier = getModelInfo(opts.defaultModel)?.tier as EETier | undefined;
  if (defaultTier) {
    const evidence = resolveTurnTier(defaultTier, opts, recentFailures);
    if (evidence.tier !== defaultTier) {
      const effective = resolveTierModel(evidence.tier, opts.defaultProvider);
      const tierModel = effective ?? getRoutedModelByTier(evidence.tier, opts.defaultProvider);
      if (tierModel && !isProviderDisabled(tierModel.provider as ProviderId)) {
        const peak = adjustPeakHourModel(tierModel.id);
        const reason = withNotes(`evidence:${defaultTier}→${evidence.tier}`, evidence.notes);
        const d: RouteDecision = {
          tier: "hot",
          model: peak.modelId,
          provider: peak.adjusted ? peak.provider : (tierModel.provider ?? opts.defaultProvider),
          reason: peak.adjusted ? `${reason}|${peak.reason}` : reason,
          source: "evidence",
        };
        const checked = await capCheck(d, opts);
        routerStore.setState({ tier: checked.tier, lastDecision: checked, source: "evidence" });
        if (cacheKey && !checked.cap_overridden) setCachedRoute(cacheKey, checked);
        return checked;
      }
    }
  }

  // Step 3: nothing moved the tier — serve the session default.
  const effective = resolveEffectiveDefaults(opts);
  const peak = adjustPeakHourModel(effective.model);
  const fallback: RouteDecision = {
    tier: routerStore.getState().degraded ? "degraded" : "hot",
    model: peak.modelId,
    provider: peak.provider,
    reason: peak.adjusted
      ? `${effective.provider !== opts.defaultProvider ? "default+rerouted(disabled-default)" : "default"}|${peak.reason}`
      : effective.provider !== opts.defaultProvider
        ? "default+rerouted(disabled-default)"
        : "default",
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
