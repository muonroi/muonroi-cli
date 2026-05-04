/**
 * Routing decision orchestrator.
 *
 * Ladder: classifier hot -> warm -> cold -> fallback.
 * Cap precedence: ledger reservation checked before returning.
 * If cap breach detected, downgrade chain overrides classifier output (ROUTE-06).
 */

import { getDefaultEEClient } from "../ee/intercept.js";
import type { RouteOutcome } from "../ee/types.js";
import { getModelByTier } from "../models/registry.js";
import { DOWNGRADE_CHAIN, downgradeChain, emitDowngrade } from "../usage/downgrade.js";
import { release, reserve } from "../usage/ledger.js";
import { midstreamPolicy } from "../usage/midstream.js";
import { CapBreachError } from "../usage/types.js";
import { classify } from "./classifier/index.js";
import { callColdRoute } from "./cold.js";
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
  if (pil?.taskType && pil.confidence > 0) {
    ctx.localRoute = { tier: pil.taskType, confidence: pil.confidence };
  }
  if (pil?.recentTurnsSummary) ctx.recentTurns = pil.recentTurnsSummary;
  if (pil?.projectSize) ctx.projectSize = pil.projectSize;
  if (pil?.filesTouched && pil.filesTouched > 0) ctx.filesTouched = pil.filesTouched;
  if (pil?.mode) ctx.mode = pil.mode;

  return ctx;
}

// ─── Provider constraint: never route to a provider the user lacks a key for ─

function constrainToProvider(decision: RouteDecision, opts: DecideOpts): RouteDecision {
  if (!decision.provider || decision.provider === opts.defaultProvider) return decision;
  const sameProviderModel = getModelByTier(
    decision.tier === "hot" ? "fast" : decision.tier === "cold" ? "premium" : "balanced",
    opts.defaultProvider,
  );
  return {
    ...decision,
    model: sameProviderModel?.id ?? opts.defaultModel,
    provider: sameProviderModel?.provider ?? opts.defaultProvider,
    reason: `${decision.reason}|provider-constrained`,
  };
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
export function reportRouteOutcome(
  taskHash: string,
  outcome: RouteOutcome,
  duration?: number,
): void {
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

/**
 * Apply cap-check to a RouteDecision. Walks the downgrade chain if
 * the reservation would breach the cap. Returns the (possibly downgraded) decision.
 */
async function capCheck(dec: RouteDecision, homeOverride?: string): Promise<RouteDecision> {
  let current = { ...dec };
  let attempts = 0;

  while (attempts++ < DOWNGRADE_CHAIN.length) {
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

  // Step 0: PIL context override — trust local classifier when confidence is high
  // Short/ambiguous messages ("fix it", "tiếp tục") can't be classified by text alone;
  // PIL has conversation context that brain LLM doesn't.
  const pilTier = opts.pil?.taskType as "fast" | "balanced" | "premium" | undefined;
  const pilConf = opts.pil?.confidence ?? 0;
  if (pilTier && pilConf >= 0.6) {
    const tierModel = getModelByTier(pilTier, opts.defaultProvider);
    const d: RouteDecision = {
      tier: "hot",
      model: tierModel?.id ?? opts.defaultModel,
      provider: tierModel?.provider ?? opts.defaultProvider,
      reason: `pil:${pilTier}(${pilConf.toFixed(2)})`,
      confidence: pilConf,
      source: "pil",
    };
    const checked = await capCheck(d, opts.homeOverride);
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
    const tierModel = c.tierHint ? getModelByTier(c.tierHint, opts.defaultProvider) : undefined;
    const d: RouteDecision = {
      tier: "hot",
      model: tierModel?.id ?? opts.defaultModel,
      provider: tierModel?.provider ?? opts.defaultProvider,
      reason: c.reason,
      confidence: c.confidence,
    };
    const checked = await capCheck(d, opts.homeOverride);
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
    const checked = await capCheck(constrainToProvider(w, opts), opts.homeOverride);
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
    const checked = await capCheck(constrainToProvider(cd, opts), opts.homeOverride);
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
  const fallback: RouteDecision = {
    tier: routerStore.getState().degraded ? "degraded" : "hot",
    model: opts.defaultModel,
    provider: opts.defaultProvider,
    reason: "fallback:ee-unreachable",
  };
  const checked = await capCheck(fallback, opts.homeOverride);
  routerStore.setState({
    lastDecision: checked,
    taskHash: null,
    source: null,
  });
  // Don't cache fallback decisions
  return checked;
}
