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
 * | `measured`     | a figure exists; `source` says who produced it    | only when `<= 0`, and see below |
 * | `unmeasured`   | tests exist; no coverage figure was produced      | NO                 |
 *
 * `unmeasured` is the state that has no honest blocking action, because the
 * absence of a measurement is evidence about the MEASURING, not about the code.
 *
 * ## Provenance, and why the two consumers of a ZERO differ
 *
 * A `measured` figure can come from two places, distinguished by
 * `VerifyRecipe.coverageSource`: a real parse of the project's own test output
 * (`"measured"`, produced by the deterministic verify floor) or a number the
 * verify sub-agent asserted in its recipe JSON (`"model-asserted"`). Precedence
 * is applied upstream — `verify-floor.ts` measures and `sprint-runner.ts`
 * overwrites an asserted number with a measured one before either gate reads the
 * recipe.
 *
 * The CLASSIFICATION is shared so the field's meaning cannot drift again. The
 * POLICY on a zero is deliberately NOT shared, because the two callers' failure
 * modes differ in visibility — `isVerifiedZeroCoverage` vs
 * `isClaimedZeroCoverage` below spell out which is which and why.
 */

import type { VerifyRecipe } from "../types/index.js";

/**
 * WHO produced the figure. This is not decoration: the two consumers of a ZERO
 * act differently on it, and only this field lets them (see the two predicates
 * below, and the divergence note in each).
 *
 * `"unknown"` covers a recipe carrying a number with no provenance stamp —
 * records persisted before `coverageSource` existed. Treated as NOT verified,
 * because an unstamped figure cannot prove it was measured.
 */
export type CoverageProvenance = "measured" | "model-asserted" | "unknown";

export type CoverageSignal =
  /** No recipe at all, or a recipe with neither a test command nor a figure. */
  | { state: "tests-absent" }
  /**
   * A figure is present, 0..1. `state: "measured"` means "a measurement is
   * CLAIMED" — `source` says by whom, and a claim is not automatically a
   * measurement.
   */
  | { state: "measured"; value: number; source: CoverageProvenance }
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
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const stamp = recipe.coverageSource;
    const source: CoverageProvenance = stamp === "measured" || stamp === "model-asserted" ? stamp : "unknown";
    return { state: "measured", value: raw, source };
  }
  if ((recipe.testCommands?.length ?? 0) === 0) return { state: "tests-absent" };
  return { state: "unmeasured" };
}

/**
 * A zero backed by an actual MEASUREMENT of the project's own test output.
 *
 * This is the only zero that may fail the per-sprint engineering floor. A number
 * a model typed into a recipe field is not a measurement — it filled in a box it
 * does not understand — and the recorded case is the proof: the recipe for run
 * `muauw6u93e1c` had no `coverage` key AT ALL, which is what an honest model does
 * with a field it cannot fill. So a `0` appearing there is likelier a formatting
 * artifact than a finding, and letting it silently score a sprint 0 forever would
 * be a second door into the exact bug this module removes.
 *
 * Never true for `unmeasured` — that coercion is what this module deletes — and
 * never for `tests-absent`, a DIFFERENT failure callers report under their own
 * reason (`no_recipe` / `no_test_commands`) so the two never blur.
 */
export function isVerifiedZeroCoverage(signal: CoverageSignal): boolean {
  return signal.state === "measured" && signal.value <= 0 && signal.source === "measured";
}

/**
 * A zero from ANY source — measured or merely asserted.
 *
 * ## Why this second predicate exists, and is not a bug
 *
 * The classification is shared so the FIELD's meaning cannot drift; the POLICY
 * on a zero is deliberately different per caller, because the consequence is
 * different:
 *
 *  - the done-gate's consequence is a silent per-sprint score of 0 that repeats
 *    forever — invisible and self-perpetuating. It uses
 *    `isVerifiedZeroCoverage`, so only a real measurement can cause it.
 *  - CB-3's consequence is a LOUD halt on sprint 1 with a recovery card the user
 *    can act on. An asserted zero there costs one visible, answerable prompt, so
 *    it uses this predicate — which also keeps CB-3's halt set byte-identical to
 *    what it was before this module existed.
 *
 * If you are adding a third caller: pick the predicate that matches your failure
 * mode's VISIBILITY, and say which and why at the call site.
 */
export function isClaimedZeroCoverage(signal: CoverageSignal): boolean {
  return signal.state === "measured" && signal.value <= 0;
}
