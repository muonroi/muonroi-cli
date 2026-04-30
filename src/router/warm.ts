/**
 * Warm-path router tier.
 *
 * Calls EE /api/route-model with a hard 250ms timeout.
 * Returns null on timeout/5xx/network error (graceful degradation).
 */
import { getDefaultEEClient } from '../ee/intercept.js';
import type { RouteDecision } from './types.js';

export async function callWarmRoute(
  prompt: string,
  opts: { tenantId: string; cwd: string; signal?: AbortSignal },
): Promise<RouteDecision | null> {
  const r = await getDefaultEEClient().routeModel(
    { prompt, tenantId: opts.tenantId, cwd: opts.cwd },
    opts.signal,
  );
  if (!r) return null;
  return {
    tier: r.tier,
    model: r.model,
    provider: r.provider,
    reason: `warm:${r.reason}`,
    confidence: r.confidence,
  };
}
