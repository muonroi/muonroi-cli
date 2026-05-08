/**
 * src/usage/estimator.ts
 *
 * Token estimation and cost projection for the reservation ledger.
 * Phase 1 explicitly accepts chars/4 estimator -- fine for cap projection, NOT for billing.
 * Phase 4 swaps in tiktoken-encoder for actual token counts.
 */

import { lookupPricing } from "../providers/pricing.js";

/**
 * Rough token estimate from character count.
 * Acceptable for cap projection only -- not for billing reconciliation.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Project the USD cost of a request given token estimates and the static pricing table.
 * Returns 0 for unknown provider/model -- caller decides how to handle (ledger treats as 0 risk).
 */
export function projectCostUSD(
  provider: string,
  model: string,
  estInputTokens: number,
  estOutputTokens: number,
): number {
  const p = lookupPricing(provider, model);
  if (!p) return 0;
  const inUSD = (estInputTokens / 1_000_000) * p.input_per_million_usd;
  const outUSD = (estOutputTokens / 1_000_000) * p.output_per_million_usd;
  return inUSD + outUSD;
}

/**
 * Cache-aware cost projection. Splits input tokens into hit (charged at the
 * cached_input rate when the model surfaces one) and miss (full input rate).
 * Falls back to {@link projectCostUSD} when the model has no cached price.
 *
 * Use this for cost previews and post-hoc reconciliation of /ideal runs where
 * DeepSeek prompt caching can change projected spend by an order of magnitude.
 */
export function projectCostUSDWithCache(
  provider: string,
  model: string,
  estInputMissTokens: number,
  estInputHitTokens: number,
  estOutputTokens: number,
): number {
  const p = lookupPricing(provider, model);
  if (!p) return 0;
  const missUSD = (estInputMissTokens / 1_000_000) * p.input_per_million_usd;
  const hitRate = p.cached_input_per_million_usd ?? p.input_per_million_usd;
  const hitUSD = (estInputHitTokens / 1_000_000) * hitRate;
  const outUSD = (estOutputTokens / 1_000_000) * p.output_per_million_usd;
  return missUSD + hitUSD + outUSD;
}
