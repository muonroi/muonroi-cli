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
