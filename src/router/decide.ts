/**
 * Routing decision orchestrator.
 *
 * Ladder: classifier hot -> warm -> cold -> fallback.
 * Cap precedence stub ready for Plan 05 to consume.
 */
import { classify } from './classifier/index.js';
import { callWarmRoute } from './warm.js';
import { callColdRoute } from './cold.js';
import { routerStore } from './store.js';
import type { RouteDecision } from './types.js';

export interface DecideOpts {
  tenantId: string;
  cwd: string;
  threshold?: number;
  signal?: AbortSignal;
  defaultModel: string;
  defaultProvider: string;
}

export async function decide(
  prompt: string,
  opts: DecideOpts,
): Promise<RouteDecision> {
  // Step 1: Hot-path local classifier
  const c = classify(prompt, opts.threshold ?? 0.55);
  if (c.tier === 'hot') {
    const d: RouteDecision = {
      tier: 'hot',
      model: c.modelHint ?? opts.defaultModel,
      provider: opts.defaultProvider,
      reason: c.reason,
      confidence: c.confidence,
    };
    routerStore.setState({ tier: 'hot', lastDecision: d });
    return d;
  }

  // Step 2: Warm path (EE /api/route-model, 250ms timeout)
  const w = await callWarmRoute(prompt, opts);
  if (w) {
    routerStore.setState({ tier: w.tier, lastDecision: w });
    return w;
  }

  // Step 3: Cold path (EE /api/cold-route, 1s timeout)
  const cd = await callColdRoute(prompt, opts);
  if (cd) {
    routerStore.setState({ tier: 'cold', lastDecision: cd });
    return cd;
  }

  // Step 4: Final fallback when EE entirely unreachable
  const fallback: RouteDecision = {
    tier: routerStore.getState().degraded ? 'degraded' : 'hot',
    model: opts.defaultModel,
    provider: opts.defaultProvider,
    reason: 'fallback:ee-unreachable',
  };
  routerStore.setState({ lastDecision: fallback });
  return fallback;
}
