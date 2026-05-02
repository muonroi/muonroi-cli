/**
 * Warm-path router tier.
 *
 * Calls EE /api/route-model with a hard 250ms timeout.
 * Returns null on timeout/5xx/network error (graceful degradation).
 */
import { routeModel as bridgeRouteModel } from "../ee/bridge.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import type { RouteDecision } from "./types.js";

export async function callWarmRoute(
  prompt: string,
  opts: { tenantId: string; cwd: string; signal?: AbortSignal; context?: Record<string, unknown> },
): Promise<RouteDecision | null> {
  // ── Bridge cascade: try in-process first (~5ms) before HTTP (~250ms) ──
  const bridgeResult = await bridgeRouteModel(prompt, opts.context ?? {}, "muonroi-cli");
  if (bridgeResult) {
    return {
      tier: bridgeResult.tier === "fast" ? "hot" : bridgeResult.tier === "premium" ? "cold" : "warm",
      model: bridgeResult.model,
      provider: "",
      reason: `warm:bridge:${bridgeResult.reason}`,
      confidence: bridgeResult.confidence,
      taskHash: bridgeResult.taskHash ?? undefined,
      source: bridgeResult.source,
      reasoningEffort: bridgeResult.reasoningEffort as RouteDecision["reasoningEffort"],
    };
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
    provider: "",
    reason: `warm:${r.reason}`,
    confidence: r.confidence,
    taskHash: r.taskHash,
    source: r.source,
    reasoningEffort: r.reasoningEffort,
  };
}
