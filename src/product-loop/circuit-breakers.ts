import type { VerifyRecipe } from "../types/index.js";

/**
 * CB-1 Cost Projection
 * formula: ewma = recent.reduce((avg, c) => avg * 0.7 + c * 0.3, recent[0])
 * projection = ewma * 1.2
 * halt if projection > (capUsd - spentUsd) * 1.5
 */
export function CB1_costProjection(
  history: { actualCost: number }[],
  capUsd: number,
  spentUsd: number,
  baselineCost?: number,
): { halt: boolean; projection: number; headroom: number } {
  const recent = history.slice(-3).map((s) => s.actualCost);

  let ewma: number;
  if (recent.length === 0) {
    ewma = baselineCost ?? 0;
  } else {
    ewma = recent.reduce((avg, c) => avg * 0.7 + c * 0.3, recent[0]);
  }

  const projection = ewma * 1.2;
  const remaining = capUsd - spentUsd;
  const halt = projection > remaining * 1.5;

  return { halt, projection, headroom: remaining };
}

/**
 * CB-2 Oscillation
 * halt = sprintN >= 3 && delta_t <= 0 && delta_t_minus_1 <= 0
 * where delta_t = sprint[t].score - sprint[t-1].score
 */
export function CB2_oscillation(
  history: { score: number }[],
  sprintN: number,
): { halt: boolean; delta_t: number; delta_t_minus_1: number } {
  if (sprintN < 3 || history.length < 3) {
    return { halt: false, delta_t: 0, delta_t_minus_1: 0 };
  }

  const t = history.length - 1;
  const delta_t = history[t].score - history[t - 1].score;
  const delta_t_minus_1 = history[t - 1].score - history[t - 2].score;

  const halt = delta_t <= 0 && delta_t_minus_1 <= 0;

  return { halt, delta_t, delta_t_minus_1 };
}

/**
 * CB-3 Verify Blank
 * halt = sprintN === 1 && (recipe === null || recipe.coverage === 0)
 */
export function CB3_verifyBlank(
  sprintN: number,
  recipe: VerifyRecipe | null,
): { halt: boolean; reason?: "no_recipe" | "zero_coverage" } {
  if (sprintN !== 1) {
    return { halt: false };
  }

  if (recipe === null) {
    return { halt: true, reason: "no_recipe" };
  }

  // recipe.coverage can be undefined, null, or 0.
  // CONTEXT.md says: recipe.coverage === 0
  if (recipe.coverage === 0) {
    return { halt: true, reason: "zero_coverage" };
  }

  return { halt: false };
}

/**
 * CB-0 Budget gauge readable — FAIL-CLOSED.
 *
 * Measured defect (N4a, run `mttwpmu8ee5b`): every budget surface read a spend
 * figure that was `0` for the entire discover/gather/research/scoping stretch,
 * and `remainingUsd` was computed as `max(0, cap - spent)`. With `spent`
 * pinned at 0 the loop believed it had the FULL cap in hand at every gate, for
 * a run that had already spent real money. A gauge that fails to zero does not
 * just under-report — it actively authorises spending.
 *
 * Fail-CLOSED is the deliberate choice here, and it differs from the fail-open
 * choice made for the verify-floor baseline (`phase-runner.ts`) on purpose:
 *   - the verify baseline failing open costs a slightly harsher score;
 *   - the budget gauge failing open costs unbounded money on the user's card.
 * Money is the asymmetric risk, so an unreadable gauge halts rather than
 * silently authorising unlimited spend.
 *
 * The escape hatch is an explicit opt-in the user has to type —
 * `MUONROI_IDEAL_ALLOW_BLIND_BUDGET=1` — so an unmetered run is something
 * somebody asked for, not something inherited from a broken meter. (It is NOT
 * `--max-cost 0`: `src/ui/slash/ideal.ts:177` clamps that flag to 1..1000, so a
 * capUsd of 0 is not reachable from the CLI. The `capUsd <= 0` branch below
 * exists for programmatic callers that declare no cap at all.)
 */
export function CB0_budgetGaugeReadable(
  spend: { known: true; usd: number } | { known: false; reason: string },
  capUsd: number,
): { halt: boolean; reason?: string } {
  if (spend.known) return { halt: false };
  if (process.env.MUONROI_IDEAL_ALLOW_BLIND_BUDGET === "1") return { halt: false };
  if (!(capUsd > 0)) return { halt: false }; // no cap declared ⇒ nothing for the gauge to enforce
  return {
    halt: true,
    reason:
      `Spend is unreadable (${spend.reason}), so the $${capUsd.toFixed(2)} cap cannot be enforced. ` +
      "Halting rather than spending against a blind meter. Usage is recorded per chat session, so a run " +
      "with no session id cannot be metered at all. Set MUONROI_IDEAL_ALLOW_BLIND_BUDGET=1 to run unmetered anyway.",
  };
}
