/**
 * src/product-loop/cost-scoper.ts
 *
 * Wrapper around the ledger to support per-product budget namespaces.
 * Enforces two-cap semantics: halt on first cap hit (monthly OR per-product).
 */

import { reserve } from "../usage/ledger.js";
import { getProductSpentUsd } from "../usage/product-ledger.js";
import { projectCostUSD } from "../usage/estimator.js";
import { CapBreachError, type ReservationToken } from "../usage/types.js";

/**
 * Reserve projected spend while enforcing TWO caps:
 * 1. The per-product run budget (productCapUsd)
 * 2. The user's monthly overall cap (enforced by ledger.reserve)
 *
 * Halt on FIRST cap hit — do not proceed to monthly check if per-product already breached.
 */
export async function reserveForProduct(
  args: {
    provider: string;
    model: string;
    estInputTokens: number;
    estOutputTokens: number;
    homeOverride?: string;
  },
  productRunId: string,
  productCapUsd: number,
  homeOverride?: string,
): Promise<ReservationToken | CapBreachError> {
  // 1. Check per-product cap first (pre-flight)
  const spent = await getProductSpentUsd(productRunId, homeOverride);
  const projected = projectCostUSD(args.provider, args.model, args.estInputTokens, args.estOutputTokens);

  if (spent + projected > productCapUsd) {
    return new CapBreachError(spent, 0, projected, productCapUsd);
  }

  // 2. Check monthly cap via standard reserve
  const result = await reserve({ ...args, homeOverride });

  // 3. Tag token with productRunId if successful
  if (!(result instanceof CapBreachError)) {
    result.productRunId = productRunId;
  }

  return result;
}
