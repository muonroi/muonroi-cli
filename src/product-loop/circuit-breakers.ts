import type { VerifyRecipe } from "../types/index.js";
import { classifyCoverage, isMeasuredZeroCoverage } from "./coverage-signal.js";

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
 * halt = sprintN === 1 && (recipe === null || coverage is a MEASURED zero)
 *
 * ## Which semantics won, and why
 *
 * This breaker and `done-gate.ts` read the SAME `VerifyRecipe.coverage` field
 * and used to disagree about absent: CB-3's `=== 0` left absent alone, the
 * done-gate's `?? 0` turned absent into a zero and blocked on it. CB-3's is the
 * honest reading and is the one both now share, via `classifyCoverage`:
 *
 *  - `?? 0` manufactures a measurement that was never taken. CB-3 halts the
 *    WHOLE RUN, so the more drastic gate being the more careful one about what
 *    it claims to know — while the milder per-sprint gate blocked on an invented
 *    number — was incoherent on its face.
 *  - It is also the behaviour-preserving direction here: every input that halted
 *    CB-3 before still halts it, and no input that passed now halts. The change
 *    is entirely on the done-gate's side, which is where the bug was.
 *
 * Deliberately NOT changed: a NON-null recipe declaring zero test commands and no
 * figure is `tests-absent`, and CB-3 still does not halt on it. Halting there
 * would newly stop runs that complete today (`detectFallbackRecipe` yields
 * `testCommands: []` for any unrecognised project), which is a policy change
 * beyond this field's meaning. The done-gate reports that state per-sprint as
 * `no_test_commands`.
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

  if (isMeasuredZeroCoverage(classifyCoverage(recipe))) {
    return { halt: true, reason: "zero_coverage" };
  }

  return { halt: false };
}
