/**
 * Which recovery option the halt card pre-selects, and the reason it shows for
 * it — ONE derivation, so the two cannot disagree.
 *
 * ## The defect this replaces
 *
 * Every halt-card construction site called `setHaltSelectedIndex(0)`, and for
 * the CB-3 card index 0 is "Init new project". So the user's Enter sat on the
 * one option that creates files and shells out (`initNewProject`,
 * src/scaffold/init-new.ts:1210 — it writes `<cwd>/<name>` and runs
 * `dotnet new` + NuGet installs; it refuses an existing directory at :1229, so
 * it cannot clobber, but it is still the only option here that mutates the
 * user's tree), on a repository that already exists. Nothing computed a
 * recommendation at all: `HaltChunk` carried no recommendation and no
 * `defaultIndex`, and the card named three options with no reason to prefer
 * any of them — while CB-3's `detail` was already `deriveNextAction(...).action`,
 * i.e. a derived instruction sitting right above a default that ignored it.
 *
 * That is the same shape as the post-debate card fixed in 109aeef7, where the
 * label, the reason and the pre-selection were three independent computations
 * and the card recommended "Save & Exit" beside a reason arguing for refine. So
 * the fix here is the same fix: the index, the id and the displayed reason are
 * fields of ONE returned object, derived from one input, and every surface reads
 * that object rather than recomputing its own answer.
 *
 * ## The two rules
 *
 * 1. **A destructive option is never pre-selected.** Not by ranking it last —
 *    by never being reachable: the preference tables contain no destructive id
 *    and the result is filtered again ({@link DESTRUCTIVE_RECOVERY_OPTION_IDS}).
 *    When a card offers nothing else, the honest answer is to pre-select
 *    NOTHING (`index: -1`) and make the user move the cursor deliberately.
 * 2. **A recommendation is only called a recommendation when an option
 *    actually carries out the derived fix.** `deriveNextAction`'s
 *    {@link FixLocus} says where the change has to happen; only the options
 *    whose own effect is that place qualify ({@link CARRIES_OUT_BY_LOCUS}).
 *    "Add tests that execute this project's code" is NOT carried out by
 *    "Continue as council brainstorm" (that writes a spec.md), so the card says
 *    so instead of dressing the safest option up as the answer.
 */

import type { FixLocus, NextActionAdvice } from "./next-action.js";
import type { HaltChunk, RecoveryOption } from "./types.js";

type RecoveryOptionId = RecoveryOption["id"];

/**
 * Options that destroy work, skip a safety gate, or write into the user's tree.
 * None of these may ever be the pre-selected option.
 *
 * - `init_new` — opens the scaffold form; on confirm `initNewProject` creates a
 *   project directory under the cwd and runs `dotnet new` + NuGet restores.
 * - `abort` — "Hard-kill this run. It can no longer be resumed."
 * - `skip_verify` — sets `MUONROI_SPRINT_SKIP_VERIFY=1`, i.e. ships a sprint
 *   with the verify gate switched off.
 */
export const DESTRUCTIVE_RECOVERY_OPTION_IDS: ReadonlySet<RecoveryOptionId> = new Set<RecoveryOptionId>([
  "init_new",
  "abort",
  "skip_verify",
]);

/**
 * For each locus, the options whose OWN effect is a change in that place —
 * i.e. picking it actually performs the derived next action.
 *
 * - `recipe` — how this project is verified could not be derived. Pointing the
 *   run at the directory that holds the tests re-runs verify-detect there,
 *   which is literally what the `no_recipe` advice asks for.
 * - `code` / `criteria` — a sprint writes code and closes criteria, so
 *   re-entering the loop performs the fix.
 * - `manifest` / `environment` / `human` — a person must change a declaration,
 *   install something, or decide. No option on this card does any of that.
 * - `none` — the gate passed; there is nothing to recover from.
 */
const CARRIES_OUT_BY_LOCUS: Readonly<Record<FixLocus, readonly RecoveryOptionId[]>> = {
  recipe: ["point_to_existing"],
  code: ["resume", "retry"],
  criteria: ["resume", "retry"],
  manifest: [],
  environment: [],
  human: [],
  none: [],
};

/**
 * Fallback cursor placement when no option carries out the fix (or nothing was
 * derived at all): least consequential first. `point_to_existing` only asks for
 * a path and re-runs detection; `resume` / `retry` re-enter the loop;
 * `continue_as_council` spends tokens on a debate and writes a spec.
 */
const SAFEST_FIRST: readonly RecoveryOptionId[] = ["point_to_existing", "resume", "retry", "continue_as_council"];

export type HaltRecommendationKind =
  /** An offered option performs the derived next action. */
  | "carries-the-fix"
  /** Nothing offered performs it; the cursor sits on the least consequential option. */
  | "safest-available"
  /** Every offered option is destructive — nothing is pre-selected. */
  | "none";

export interface HaltRecommendation {
  /**
   * Index into `recovery_options` to pre-select, or `-1` for "pre-select
   * nothing". Always points at a non-destructive option when it is >= 0.
   */
  index: number;
  /** The option at {@link index}, or null when `index` is -1. */
  optionId: RecoveryOptionId | null;
  kind: HaltRecommendationKind;
  /**
   * The line the card shows. It always names the option at {@link index} (or
   * says that nothing was pre-selected), so the rendered reason cannot argue
   * for a different option than the one the cursor is on.
   */
  reason: string;
}

/**
 * What the recommendation needs off a halt chunk: the options, plus the advice
 * and the detail when the producer has them. A whole {@link HaltChunk} is
 * accepted (both real callers pass one) — nothing else on it is read, which is
 * asserted by the reason-agnostic test.
 */
export type HaltRecommendationInput = Pick<HaltChunk, "recovery_options"> &
  Partial<Omit<HaltChunk, "recovery_options">>;

function firstPresent(
  options: readonly RecoveryOption[],
  preferred: readonly RecoveryOptionId[],
): { index: number; option: RecoveryOption } | null {
  for (const id of preferred) {
    const index = options.findIndex((o) => o.id === id && !DESTRUCTIVE_RECOVERY_OPTION_IDS.has(o.id));
    if (index >= 0) return { index, option: options[index] };
  }
  return null;
}

/**
 * The advice line, or a short stand-in when the card already prints it as its
 * `detail` (CB-3 sets `detail: deriveNextAction(...).action`, so repeating it
 * verbatim in the reason would print the same paragraph twice).
 */
function actionPhrase(advice: NextActionAdvice, detail: string | undefined): string {
  return (detail ?? "").includes(advice.action) ? "what the line above asks for" : advice.action;
}

export function deriveHaltRecommendation(halt: HaltRecommendationInput): HaltRecommendation {
  const options = halt.recovery_options ?? [];
  const advice = halt.advice;

  const carrier = advice ? firstPresent(options, CARRIES_OUT_BY_LOCUS[advice.locus] ?? []) : null;
  if (carrier && advice) {
    return {
      index: carrier.index,
      optionId: carrier.option.id,
      kind: "carries-the-fix",
      reason: `Recommended: ${carrier.option.label} — ${actionPhrase(advice, halt.detail)}`,
    };
  }

  const safest =
    firstPresent(options, SAFEST_FIRST) ??
    firstPresent(
      options,
      options.map((o) => o.id),
    );
  if (safest) {
    const tail = advice
      ? ` Nothing offered carries out the actual fix: ${actionPhrase(advice, halt.detail)}`
      : " Nothing was recorded about why the run halted, so this is not a claim about the failure.";
    return {
      index: safest.index,
      optionId: safest.option.id,
      kind: "safest-available",
      reason: `Pre-selected: ${safest.option.label} — the least consequential option offered; it cannot discard work, skip a gate or write into this tree.${tail}`,
    };
  }

  const tail = advice ? ` The actual fix: ${actionPhrase(advice, halt.detail)}` : "";
  return {
    index: -1,
    optionId: null,
    kind: "none",
    reason: `Nothing here is pre-selected: every option would discard work, skip a gate or write into this tree. Choose one deliberately with ↑/↓, or press Esc to stop.${tail}`,
  };
}
