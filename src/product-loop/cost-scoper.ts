/**
 * src/product-loop/cost-scoper.ts
 *
 * Per-product spend METERING for `/ideal`.
 *
 * This module used to reserve projected spend against two caps — the per-run
 * `--max-cost` and the monthly `cap.monthly_usd` — and refuse the call on the
 * first breach, which surfaced inside a sprint as `Cost cap breached: …` thrown
 * out of the planning/council LLM. `/ideal` has no spend cap (user decision), so
 * nothing is reserved and nothing is refused.
 *
 * The spend is still MEASURED on both ledgers, after the call returns: the
 * monthly `usage.json` (so the user's overall picture stays true) and the
 * per-run JSONL ledger (per-callsite / per-role attribution).
 */

import { projectCostUSD } from "../usage/estimator.js";
import { commitUnreserved } from "../usage/ledger.js";
import { appendProductLedger, type CostMeta } from "../usage/product-ledger.js";

export async function recordProductSpend(
  call: {
    provider: string;
    model: string;
    actualInputTokens: number;
    actualOutputTokens: number;
    estInputTokens?: number;
  },
  productRunId: string,
  meta?: CostMeta,
  homeOverride?: string,
): Promise<void> {
  const actualUsd = projectCostUSD(call.provider, call.model, call.actualInputTokens, call.actualOutputTokens);

  // Metering must never break the call it measures — but a failure is logged,
  // never swallowed, because an unmeasured run looks exactly like a free one.
  try {
    await commitUnreserved({
      provider: call.provider,
      model: call.model,
      actualInputTokens: call.actualInputTokens,
      actualOutputTokens: call.actualOutputTokens,
      homeOverride,
    });
  } catch (err) {
    console.error(`[cost-scoper] monthly ledger commit failed for run ${productRunId}: ${(err as Error)?.message}`, {
      provider: call.provider,
      model: call.model,
      actualUsd,
    });
  }

  try {
    await appendProductLedger(
      productRunId,
      {
        ts: Date.now(),
        productRunId,
        reservationId: "unreserved",
        actualUsd,
        model: call.model,
        provider: call.provider,
        estInputTokens: call.estInputTokens,
        actualInputTokens: call.actualInputTokens,
        actualOutputTokens: call.actualOutputTokens,
        ...meta,
      },
      homeOverride,
    );
  } catch (err) {
    console.error(`[cost-scoper] product ledger append failed for run ${productRunId}: ${(err as Error)?.message}`, {
      provider: call.provider,
      model: call.model,
      actualUsd,
    });
  }
}
