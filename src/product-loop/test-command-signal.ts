/**
 * src/product-loop/test-command-signal.ts
 *
 * The ONE definition of what `VerifyRecipe.testCommands` means to a GATE, and
 * the one place the disk's answer is folded into the model's.
 *
 * Sibling of `./coverage-signal.ts`: same field-with-two-meanings defect, same
 * shape of fix (classify in one place, stamp the provenance, let a MEASURED fact
 * beat an ASSERTED one). Read that module first — everything about why the
 * provenance stamp exists is argued there and is not repeated here.
 *
 * ## The defect this exists to make impossible
 *
 * `verify-floor.ts:21-29` already refuses to take its commands from the recipe
 * the verify sub-agent returned, and says why:
 *
 * > They are deliberately NOT taken from the `VerifyRecipe` the verify sub-agent
 * > returned: that recipe is model-influenced, so a model that emitted
 * > `testCommands: []` would silently disarm its own gate. Disk-derived commands
 * > are unspoofable from inside the turn.
 *
 * The done-gate one layer up read `(ctx.recipe?.testCommands?.length ?? 0) > 0`
 * — the exact value the floor refuses to trust. So the floor defended itself and
 * the gate above it was handed the undefended number.
 *
 * Measured, run `muc2joffe506` on `D:\sources\CompanyLibs\qa-platform`, sprint 1,
 * finished `2026-09-24T06:24:32.474Z`. `sprints/1-outcome.json`:
 *
 *     {"pass": false, "score": 0, "verify": "FAIL",
 *      "failedCondition": "engineering_floor", "reason": "no_test_commands",
 *      "criteriaMet": 0, "criteriaUnmet": 4}
 *
 * `sprints/1-verify.md` from the same sprint shows the floor RAN a test command
 * in the same minute:
 *
 *     - [build] `cd frontend && npm run build` → OK (22974ms)
 *     - [test] `npm run test` → NO-TESTS-EXECUTED (empty_selection: collected 0 items / 1 error) (11030ms)
 *
 * and `resolveFloorCommands` on that tree returns
 * `{test: ["cd backend && \".venv/Scripts/python.exe\" -m pytest"]}`. The recipe
 * the gate read was the stored `qa-platform/.muonroi-cli/environment.json`
 * (`testCommands: []`, `ecosystem: "node-python-docker"`, last written
 * 2026-09-23 21:29 and never re-derived). A sprint whose test gate had just
 * executed was scored "this project declares no test command".
 *
 * ## UNION, not replacement — and why that is enough
 *
 * {@link mergeDerivedTestCommands} ADDS the disk-derived set to the model's; it
 * never removes from it. Both halves of the requirement fall out of that:
 *
 *  - A model CANNOT disarm the gate. Disarming means making the set smaller, and
 *    a union with the disk's set is never smaller than the disk's set. Emitting
 *    `[]` now subtracts nothing.
 *  - A model that legitimately knows a command the detector cannot see does not
 *    lose it. The detectors read manifests (`package.json` scripts, pytest
 *    rootdir markers, `*.sln`, `Makefile` — see `inferVerifyProjectProfile`);
 *    a bespoke contract/smoke script invoked by path is invisible to all of them
 *    and is exactly the kind of thing a verify sub-agent that just read the repo
 *    does know.
 *
 * Replacement would delete that second class for no gain in the first, since the
 * anti-disarm property comes from the ADD alone. What replacement WOULD also buy
 * is blocking a model from inventing a test command that does not exist, to
 * forge `hasTests`. That hole is unchanged by this module (it predates it) and is
 * not closed here on purpose: the floor never reads this field, so a forged
 * command is never EXECUTED — it buys a `hasTests` that still has to survive a
 * floor PASS on real exit codes, and a suite that never ran is caught by
 * `detectNoTestsExecuted`. Closing it by replacement would cost the honest case
 * above, which is the worse trade.
 *
 * ## Where the derivation comes from
 *
 * The caller passes it in; this module performs no disk probe of its own. The
 * only production caller is `sprint-runner.ts`, which hands over
 * `VerifyFloorResult.commandsDiscovered.test` — the set the floor ALREADY
 * resolved once for this verify pass via `resolveFloorCommands(cwd)`. There is
 * deliberately no second probe: one probe per verify pass, the same bounds, the
 * same cwd, the same filter (style gates excluded unless
 * `MUONROI_SPRINT_FLOOR_STYLE_GATES=1`).
 */

import type { VerifyRecipe } from "../types/index.js";

/**
 * WHO put the commands currently in `testCommands` there.
 *
 * Unlike `CoverageProvenance`, no GATE DECISION depends on this value: the
 * question a gate asks of `testCommands` is "is there at least one?", and a
 * command is a command whoever named it. It exists so the record says which
 * source opened the floor — a floor that opened on a command the model never
 * mentioned is worth being able to read back, and silently discarding that is
 * how a gate stops being auditable (the same argument as the coverage-provenance
 * log in `done-gate.ts`).
 *
 * `"unknown"` covers a recipe carrying commands with no provenance stamp:
 * records persisted before `testCommandsSource` existed, and every recipe
 * produced by a path that does not stamp (the disk profiler, `environment.json`).
 */
export type TestCommandProvenance = "model-asserted" | "disk-derived" | "both" | "unknown";

export type TestCommandSignal =
  /** No recipe, or a recipe naming no runnable test command. */
  | { state: "none" }
  /** At least one runnable test command. `source` says who named them. */
  | { state: "present"; commands: string[]; source: TestCommandProvenance };

/** A command is runnable only if it is a non-blank string. */
function runnable(commands: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(commands)) return [];
  return commands.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim());
}

/**
 * Classify a recipe's test-command evidence. Total — every recipe lands in
 * exactly one state, and no caller re-derives the rule.
 *
 * A blank entry is not a command: `resolveFloorCommands` applies the same
 * `trim().length > 0` filter before it will execute one
 * (`verify-floor.ts:328-330`), so a gate that counted `["  "]` as a test suite
 * would be asserting evidence the floor would never produce.
 */
export function classifyTestCommands(recipe: VerifyRecipe | null | undefined): TestCommandSignal {
  if (!recipe) return { state: "none" };
  const commands = runnable(recipe.testCommands);
  if (commands.length === 0) return { state: "none" };
  const stamp = recipe.testCommandsSource;
  const source: TestCommandProvenance =
    stamp === "model-asserted" || stamp === "disk-derived" || stamp === "both" ? stamp : "unknown";
  return { state: "present", commands, source };
}

/**
 * Fold the run's DISK-DERIVED test commands into a recipe, stamping who
 * contributed.
 *
 * The model's commands keep their position and order and come first — the
 * primary stack's gates are meant to run first (`composeRecipe`'s own ordering
 * rule) and a merge must not silently re-prioritise a set someone else ordered.
 * A derived command the model already named is not duplicated; comparison is on
 * the trimmed string, which is the same identity `resolveFloorCommands` and
 * `loadFloorBaseline` compare on.
 *
 * Returns `null` for a null recipe and never manufactures one: `no_recipe` is a
 * DIFFERENT floor failure from `no_test_commands`, and turning the first into a
 * pass on commands nobody asked for would blur two failures the gate reports
 * apart on purpose (and would reach past CB-3, which reads the pre-floor recipe).
 *
 * Pure: the input recipe is never mutated.
 */
export function mergeDerivedTestCommands(
  recipe: VerifyRecipe | null | undefined,
  derived: readonly string[] | null | undefined,
): VerifyRecipe | null {
  if (!recipe) return null;

  const asserted = runnable(recipe.testCommands);
  const diskDerived = runnable(derived);

  const merged = [...asserted];
  for (const command of diskDerived) {
    if (!merged.includes(command)) merged.push(command);
  }

  // Null, not a string, when there is nothing to attribute — the same "absence
  // is not a value" rule `coverageSource` follows.
  const source: VerifyRecipe["testCommandsSource"] =
    asserted.length > 0 && diskDerived.length > 0
      ? "both"
      : asserted.length > 0
        ? "model-asserted"
        : diskDerived.length > 0
          ? "disk-derived"
          : null;

  return { ...recipe, testCommands: merged, testCommandsSource: source };
}
