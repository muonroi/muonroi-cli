/**
 * Warm-path router tier.
 *
 * Calls EE /api/route-model with a hard 250ms timeout.
 * Returns null on timeout/5xx/network error (graceful degradation).
 */
import { routeModel as bridgeRouteModel } from "../ee/bridge.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { getModelByTier } from "../models/registry.js";
import { PROVIDER_INHERIT } from "./provider-sentinel.js";
import type { RouteDecision } from "./types.js";

/**
 * Map the session's provider to the EE runtime whose tier ladder the EE serves.
 * EE keys its `getModelTiers()` ladders by agent runtime, not provider, and only
 * the catalog-backed runtimes (claude/codex/gemini) resolve to a non-null model.
 * Providers without an EE runtime (deepseek/siliconflow/xai) map to "" — EE then
 * returns the routing TIER with a null model and we resolve the concrete model
 * from the shared catalog for the session provider. This removes the old
 * hardcoded `runtime:"claude"`, which leaked EE's stale `claude-*` ids into the
 * CLI for every session regardless of the active provider.
 */
const PROVIDER_TO_EE_RUNTIME: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
});

function eeRuntimeForProvider(provider: string | undefined): string {
  return (provider && PROVIDER_TO_EE_RUNTIME[provider]) || "";
}

const TIER_TO_CATALOG_TIER = { fast: "fast", balanced: "balanced", premium: "premium" } as const;

export async function callWarmRoute(
  prompt: string,
  opts: {
    tenantId: string;
    cwd: string;
    signal?: AbortSignal;
    context?: Record<string, unknown>;
    /** Active session provider — derives the EE runtime + catalog fallback. */
    defaultProvider?: string;
  },
): Promise<RouteDecision | null> {
  // ── Bridge cascade: try in-process first (~5ms) before HTTP (~250ms) ──
  // Runtime is derived from the session provider, NOT hardcoded to "claude".
  const runtime = eeRuntimeForProvider(opts.defaultProvider);
  const bridgeResult = await bridgeRouteModel(prompt, opts.context ?? {}, runtime);
  if (bridgeResult) {
    // EE returns a model only for catalog-backed runtimes; otherwise resolve the
    // concrete model from the catalog for the session provider + decided tier.
    const catalogTier = TIER_TO_CATALOG_TIER[bridgeResult.tier as keyof typeof TIER_TO_CATALOG_TIER] ?? "balanced";
    const model = bridgeResult.model || getModelByTier(catalogTier, opts.defaultProvider)?.id;
    if (model) {
      return {
        tier: bridgeResult.tier === "fast" ? "hot" : bridgeResult.tier === "premium" ? "cold" : "warm",
        model,
        // Unify with the HTTP path on PROVIDER_INHERIT: let constrainToProvider()
        // resolve the provider from the model and apply the disabled-provider
        // policy uniformly, instead of pinning a concrete provider here.
        provider: PROVIDER_INHERIT,
        reason: `warm:bridge:${bridgeResult.reason}`,
        confidence: bridgeResult.confidence,
        taskHash: bridgeResult.taskHash ?? undefined,
        source: bridgeResult.source,
        reasoningEffort: bridgeResult.reasoningEffort as RouteDecision["reasoningEffort"],
      };
    }
  }

  // ── HTTP fallback: EE server route-model endpoint ──
  const r = await getDefaultEEClient().routeModel(
    { task: prompt, tenantId: opts.tenantId, cwd: opts.cwd, context: opts.context as never },
    opts.signal,
  );
  if (!r) return null;
  return {
    tier: r.tier === "fast" ? "hot" : r.tier === "premium" ? "cold" : "warm",
    model: r.model,
    // PROVIDER_INHERIT signals constrainToProvider() to leave the EE's
    // model choice intact rather than re-routing it to the session default
    // provider. Populating this would silently override warm decisions
    // whenever EE picks a different provider than the session
    // (see src/router/warm.test.ts:137 and src/router/decide.test.ts:64).
    provider: PROVIDER_INHERIT,
    reason: `warm:${r.reason}`,
    confidence: r.confidence,
    taskHash: r.taskHash,
    source: r.source,
    reasoningEffort: r.reasoningEffort,
  };
}
