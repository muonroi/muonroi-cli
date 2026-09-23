/**
 * src/product-loop/coverage-signal.ts
 *
 * The ONE definition of what `VerifyRecipe.coverage` means.
 *
 * ## The defect this exists to make impossible
 *
 * `coverage` used to be read in two places with two different meanings:
 *
 * - `done-gate.ts`: `const hasCoverage = (ctx.recipe?.coverage ?? 0) > 0` —
 *   absent coverage was coerced to 0, i.e. "not measured" became "measured, and
 *   it is zero". It is condition 1 of 5 and short-circuits.
 * - `circuit-breakers.ts` (CB-3): `recipe.coverage === 0` — absent coverage was
 *   NOT a zero, the exact opposite reading of the same field.
 *
 * Measured consequence, run `muauw6u93e1c` (tcis-libraries, a .NET repo):
 * `sprints/1-verify.md` ended `VERIFY_PASS` ("build and full test suite now pass
 * cleanly", "**Blockers** None"), `sprints/1-goal-gate.json` recorded
 * `{"fired": false, "source": "aligned", "diffChars": 12710}` over 5+ real
 * files — and `sprints/1-outcome.json` still recorded
 * `{"pass": false, "score": 0, "failedCondition": "engineering_floor",
 * "reason": "zero_coverage"}`. Both sprints scored 0.00 in `iterations.md`. The
 * only producer of the number is `normalizeVerifyRecipe`
 * (`src/verify/recipes.ts`), which keeps a number the MODEL wrote into the
 * recipe JSON and otherwise stores null — so on any repo where the model does
 * not hand-write one, the floor could never open.
 *
 * ## The three states, and why there are three
 *
 * A signal must not assert what it cannot know. "There are no tests" and
 * "tests ran and passed but nobody measured coverage" are different facts, and
 * only the first is a reason to block anything:
 *
 * | state        | meaning                                             | may block a floor? |
 * |--------------|-----------------------------------------------------|--------------------|
 * | `tests-absent` | no recipe, no test command AND no figure           | YES — nothing was verified |
 * | `measured`     | a real number; `<= 0` means genuinely uncovered   | only when `<= 0`   |
 * | `unmeasured`   | tests exist; no coverage figure was produced      | NO                 |
 *
 * `unmeasured` is the state that has no honest blocking action, because the
 * absence of a measurement is evidence about the MEASURING, not about the code.
 *
 * ## Provenance
 *
 * A `measured` value can come from two places, distinguished by
 * `VerifyRecipe.coverageSource`: a real parse of the project's own test output
 * (`"measured"`, produced by the deterministic verify floor) or a number the
 * verify sub-agent asserted in its recipe JSON (`"model-asserted"`). Both are
 * treated as measurements here — an asserted 0 is still a positive claim of
 * zero, which is how CB-3 has always read it. Precedence is applied upstream:
 * `verify-floor.ts` measures, and `sprint-runner.ts` overwrites an asserted
 * number with a measured one before either gate ever reads the recipe.
 */

import type { VerifyRecipe } from "../types/index.js";

export type CoverageSignal =
  /** No recipe at all, or a recipe with neither a test command nor a figure. */
  | { state: "tests-absent" }
  /** A real figure, 0..1. `value <= 0` is a genuine "nothing is covered". */
  | { state: "measured"; value: number }
  /** Tests exist, but no coverage figure was produced by anyone. */
  | { state: "unmeasured" };

/**
 * Classify a recipe's coverage evidence. Total — every recipe lands in exactly
 * one state, and no caller re-derives the rule.
 *
 * ORDER MATTERS, and it is chosen so that CB-3's halt set is byte-identical to
 * what it was before this module existed. A present figure is classified FIRST,
 * before the test-command check: a recipe that declares `coverage: 0` while
 * listing no test command halted CB-3 under the old `recipe.coverage === 0`, and
 * still does. `tests-absent` therefore describes having neither a command nor a
 * figure — the case where nothing could have been measured and nothing claims to
 * have been. Callers that care about the missing command in its own right check
 * `testCommands` themselves and report it under their own reason (the done-gate's
 * `no_test_commands`), so the two failures are never blurred into one.
 *
 * A non-finite number (`NaN`, `Infinity`) is NOT a measurement: it carries no
 * value, so it falls through rather than being silently compared.
 */
export function classifyCoverage(recipe: VerifyRecipe | null | undefined): CoverageSignal {
  if (!recipe) return { state: "tests-absent" };
  const raw = recipe.coverage;
  if (typeof raw === "number" && Number.isFinite(raw)) return { state: "measured", value: raw };
  if ((recipe.testCommands?.length ?? 0) === 0) return { state: "tests-absent" };
  return { state: "unmeasured" };
}

/**
 * Whether the signal is a truthful claim that nothing is covered.
 *
 * TRUE only for a real measurement that came back at or below zero. Never for
 * `unmeasured` — that is the coercion this module exists to delete — and never
 * for `tests-absent`, which is a DIFFERENT failure that callers report under
 * their own reason (`no_recipe` / `no_test_commands`) so the two never blur.
 */
export function isMeasuredZeroCoverage(signal: CoverageSignal): boolean {
  return signal.state === "measured" && signal.value <= 0;
}
