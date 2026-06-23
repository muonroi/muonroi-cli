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
 * Sanitize an actual input-token count by comparing it to the estimated
 * (chars/4) count. Some providers (SiliconFlow, possibly others) return
 * implausibly low `prompt_tokens` (e.g. 10) regardless of actual prompt size,
 * which under-reports cost and inflates apparent cache-hit ratios.
 *
 * Rules:
 *   - When `actual === undefined`: return `estimated` (no data = use estimate).
 *   - When `actual === 0`: return 0 (preserve mock / failed-call semantics).
 *   - When `estimated > 0` and `actual < estimated * 0.1`: the value is likely
 *     bogus — return `estimated` so cost projections stay accurate.
 *   - Otherwise: return `actual` as-is.
 */
export function sanitizeInputTokens(actual: number | undefined, estimated: number): number {
  if (actual === undefined) return estimated;
  if (actual === 0) return 0;
  if (estimated > 0 && actual < estimated * 0.1) return estimated;
  return actual;
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
