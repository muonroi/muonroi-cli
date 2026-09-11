import type { VerifyRecipe } from "../types/index.js";

/*
 * Circuit breakers for the sprint loop.
 *
 * CB-0 (halt when the spend gauge is unreadable, to protect the cost cap) and
 * CB-1 (halt when projected spend exceeds the cap's headroom) were removed:
 * `/ideal` has no spend cap (user decision), so there is nothing for either to
 * protect. Spend is still MEASURED (run-spend.ts, usage_events, phase-budget.ts).
 *
 * CB-2 and CB-3 are not budgets: CB-2 ends a loop whose score stopped moving
 * (no progress), CB-3 stops a sprint that has nothing to verify against.
 */

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
