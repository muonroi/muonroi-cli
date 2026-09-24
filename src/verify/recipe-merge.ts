/**
 * src/verify/recipe-merge.ts
 *
 * The ONE place a STORED verify recipe and the LIVE disk derivation are folded
 * into the recipe the pipeline runs, and the one place the per-field rule for
 * doing so is written down.
 *
 * Sibling of `../product-loop/test-command-signal.ts`, whose UNION argument this
 * module generalises. Read that module first; the anti-disarm reasoning is
 * argued there and is not repeated here.
 *
 * ## The defect this exists to make impossible
 *
 * `inferVerifyProjectProfile` collapsed the two with `??`:
 *
 *     const recipe = recipeOverride ?? recipeFromComponents(cwd, components);
 *
 * A stored record therefore REPLACED the derivation wholesale, and nothing
 * re-derived the parts the record left empty. `prepareVerifyRun` writes the
 * manifest only under `if (!manifest)` (it is the only `saveVerifyEnvironment`
 * call in the codebase), so a record written once was authoritative forever: on
 * any project that had already run once, EVERY recipe-detection improvement
 * reached no consumer that reads `profile.recipe` — the sub-directory component
 * scan, the nearest sub-package-manager lookup, the pytest rootdir markers, the
 * sub-directory build gate.
 *
 * Measured, `D:\sources\CompanyLibs\qa-platform\.muonroi-cli\environment.json`,
 * written 2026-09-23 21:29 and authoritative for every run since (including run
 * `muc2joffe506` on 2026-09-24): `testCommands: []`,
 * `buildCommands: ["npm run verify"]`, `ecosystem: "node-python-docker"`. The
 * live derivation on that same tree yields
 * `{build: ["cd frontend && npm run build"],
 *   test: ["npm run test", "cd backend && \".venv/Scripts/python.exe\" -m pytest"]}`.
 *
 * ## The refresh policy: always re-derive, never rewrite
 *
 * The stored record's disk-derivable half is recomputed on EVERY run, in memory.
 * The file is never rewritten.
 *
 *  - **Cost is not a reason to cache it.** The derivation is disk-only and
 *    bounded, and `inferVerifyProjectProfile` ALREADY runs it unconditionally —
 *    `detectRecipeComponents(cwd)` is not gated on the override, because the
 *    package manager and the component-ecosystem roster need it. Before this
 *    module the recipe built from those components was computed and then thrown
 *    away. "Always" costs one composition over an already-scanned tree.
 *  - **Churn is zero**, because nothing is written. No schema version, no age
 *    bound, no "inputs changed" trigger is needed: every one of those exists to
 *    decide WHEN TO REWRITE, and we never rewrite.
 *  - **The user's file is not ours to guess about.** A manifest carries no
 *    provenance — `VerifyEnvironmentManifest` (src/types/index.ts:150) has no
 *    version, no generator stamp, no timestamp, no checksum, and
 *    `saveVerifyEnvironment` writes exactly `{recipe, sandbox}` — so a record
 *    this loop wrote and one a human hand-authored are byte-indistinguishable.
 *    The manifest path is a weak hint at best (`.muonroi-cli/` is gitignored by
 *    `ensureFootprintGitignored`, a root `environment.json` is not) and nothing
 *    stops a human editing the gitignored one. Merging in memory means that
 *    undecidable question never has to be answered.
 *  - **What a pinned recipe keeps.** Every scalar it set, every provisioning
 *    command it named, every note it carries. What it cannot do is SUBTRACT a
 *    gate the disk can see — the same anti-disarm property
 *    `mergeDerivedTestCommands` chose deliberately.
 *
 * ## Merge or replace, per field
 *
 * The split is GATE vs PROVISIONING vs SCALAR — not "list vs not".
 *
 * | field(s) | rule | why |
 * |---|---|---|
 * | `testCommands`, `buildCommands` | UNION, stored first | A gate is a check that must pass. A union is never smaller than the disk's set, so no record can disarm a gate; and a record that knows a command no detector can see (`npm run verify` is a ROOT script — the detector only ever picks `build`/`typecheck`) does not lose it. Stored keeps its position: `composeRecipe` orders the primary stack's gates first on purpose. |
 * | `shellInitCommands` | UNION, stored first | They are `export`s — additive by construction, and `buildRuntimeSandboxSettings` (orchestrator.ts:41) already unions them into `shellInit` through a `Set` one layer up. |
 * | `evidence`, `notes` | UNION, stored first | Audit trail. Dropping either side loses provenance, and neither is executed. |
 * | `installCommands`, `bootstrapCommands` | stored wins when non-empty; derived fills an empty one | Provisioning, NOT a gate, and the union argument inverts here: `npm ci` and `npm install` are two spellings of one operation and running the second after the first rewrites the lockfile. qa-platform's bootstrap is an ordered apt + nodesource sequence; joining it with a differently-sourced node install is a conflict, not a superset. |
 * | `startCommand`, `startPort`, `smokeTarget` | stored wins; `undefined` is a hole the derivation fills | Scalars — two start commands cannot both run, so there is no union to take. `docker compose up -d` is not derivable from any manifest file. |
 * | `smokeKind` | stored always wins | Non-optional, so `"none"` is a VALUE ("do not smoke"), not a hole; overriding it would start an HTTP probe the record refused. |
 * | `ecosystem`, `appKind` | stored wins UNLESS it is `"unknown"` | Non-optional, but `"unknown"` is the documented absence value — `detectFallbackRecipe` emits it and `shouldTrustDeterministicRecipe` rejects it. `node-python-docker` encodes a docker layer no disk scan can see and keys runtime provisioning, so a richer label must not be talked down to the derivation's primary-stack label. |
 * | `appLabel` | stored wins | A human-facing name, used only for progress text. |
 * | `coverage`, `coverageSource` | stored wins | The derivation never sets them; the deterministic floor overwrites them later with a MEASUREMENT (see `../product-loop/coverage-signal.ts`). |
 * | `testCommandsSource` | recomputed by {@link mergeDerivedTestCommands} | Same stamp discipline, same enum, one definition. |
 *
 * ## There is NO pin, and that is deliberate
 *
 * A consequence of the union, recorded here so the next person does not read it
 * as an oversight and does not re-litigate it without new evidence:
 *
 * **(a) A user currently cannot pin "this project genuinely has no test suite."**
 * Write `testCommands: []` into the manifest and the union will still add
 * whatever the disk suggests. There is no field, and no env flag, that suppresses
 * it.
 *
 * **(b) That is the anti-disarm property working, not a gap.** The union exists
 * precisely so a stored record cannot make the gate set SMALLER. A pin is a hole
 * in exactly that property, so it has to earn its way in on a measured case; it
 * does not get one for free because the shape is imaginable.
 *
 * **(c) The two shapes that would implement it**, if a real case appears — do not
 * build either speculatively:
 *  - a per-field pin list on the manifest (`"pinned": ["testCommands"]`), which
 *    {@link mergeStoredVerifyRecipe} would consult before unioning that field; or
 *  - the provenance stamp described above (`generatedBy` on write, absent ⇒
 *    hand-authored), letting a hand-authored record be honoured differently from
 *    one this loop wrote.
 *
 * **(d) What would justify it.** A project where the disk-derived command is
 * WRONG *and* running it is HARMFUL — it mutates state, costs real money, or
 * takes the tree somewhere a verify pass must not. A merely USELESS added command
 * does not justify a pin: the floor EXECUTES what the union adds, so a wrongly
 * added command surfaces as a failed gate with real output a human can read and
 * then fix. That is self-correcting in a way a mis-score is not — and a pin, once
 * set, is invisible: nothing in a later run says a gate was suppressed.
 *
 * ## Worked example: a record's prose can go stale while the tree moves
 *
 * qa-platform's stored record carries this note:
 *
 * > "Backend has no test framework installed (no pytest in requirements.txt, no
 * > tests/ dir). testCommands is intentionally empty."
 *
 * The union overrides that sentence, and the evidence says it should. In run
 * `muc2joffe506` the verify floor EXECUTED a test command in the same minute the
 * sprint was scored "no test commands" (`sprints/1-verify.md`, quoted at
 * `../product-loop/test-command-signal.ts:26-44`), and `resolveFloorCommands` on
 * that tree now finds a `.venv` with pytest that did not exist when the record was
 * written on 2026-09-23.
 *
 * This is the general argument for deriving from disk rather than trusting a
 * stored assertion: a record states a fact ABOUT a tree at one instant, the tree
 * keeps changing, and nothing re-checks the sentence. It is also why overriding it
 * here is safe rather than presumptuous — the override is backed by a measurement
 * of the CURRENT tree, not by a preference for the derivation.
 *
 * Pure: neither input is mutated.
 */

import { mergeDerivedTestCommands } from "../product-loop/test-command-signal.js";
import type { VerifyRecipe } from "../types/index.js";

/** The value both non-optional label fields use to mean "nothing was recognized". */
const UNRECOGNIZED = "unknown";

/**
 * Stored entries first, then the derived ones the stored set does not already
 * name. Identity is the trimmed string — the same identity `resolveFloorCommands`
 * and `mergeDerivedTestCommands` compare on — and a blank entry is not a command.
 */
function union(stored: readonly string[], derived: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of [...stored, ...derived]) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** A provisioning list the record set wins outright; an empty one is a hole. */
function provisioning(stored: readonly string[], derived: readonly string[]): string[] {
  const kept = stored.filter((entry) => typeof entry === "string" && entry.trim() !== "");
  return kept.length > 0 ? [...kept] : [...derived];
}

/**
 * Fold the live disk derivation into a stored/override recipe.
 *
 * Returns `derived` BY IDENTITY when there is no stored record, so the
 * no-manifest path is unchanged down to the object reference.
 */
export function mergeStoredVerifyRecipe(stored: VerifyRecipe | null | undefined, derived: VerifyRecipe): VerifyRecipe {
  if (!stored) return derived;

  // The test-command half is delegated, not reimplemented: that module is the ONE
  // definition of folding a disk-derived test set into a recipe, including the
  // provenance stamp. It returns null only for a null recipe, which is excluded
  // above.
  //
  // THIS UNION HAS NO OPT-OUT, ON PURPOSE. A record cannot pin "no test suite"
  // here or at `buildCommands` below. See "There is NO pin, and that is
  // deliberate" in the module header for the two shapes that would implement one,
  // and for the only evidence that would justify building it (a derived command
  // that is wrong AND harmful to run — a merely useless one costs a visible failed
  // gate, which is self-correcting where a suppressed gate is silent).
  const withTests = mergeDerivedTestCommands(stored, derived.testCommands) ?? stored;

  return {
    ...withTests,
    ecosystem: stored.ecosystem !== UNRECOGNIZED ? stored.ecosystem : derived.ecosystem,
    appKind: stored.appKind !== UNRECOGNIZED ? stored.appKind : derived.appKind,
    shellInitCommands: union(stored.shellInitCommands ?? [], derived.shellInitCommands),
    bootstrapCommands: provisioning(stored.bootstrapCommands ?? [], derived.bootstrapCommands),
    installCommands: provisioning(stored.installCommands ?? [], derived.installCommands),
    buildCommands: union(stored.buildCommands ?? [], derived.buildCommands),
    startCommand: stored.startCommand ?? derived.startCommand,
    startPort: stored.startPort ?? derived.startPort,
    smokeTarget: stored.smokeTarget ?? derived.smokeTarget,
    evidence: union(stored.evidence ?? [], derived.evidence),
    notes: union(stored.notes ?? [], derived.notes),
  };
}
