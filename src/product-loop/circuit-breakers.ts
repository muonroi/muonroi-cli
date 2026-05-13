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
