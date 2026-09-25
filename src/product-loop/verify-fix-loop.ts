/**
 * src/product-loop/verify-fix-loop.ts
 *
 * S4 — verify -> fix -> re-verify inside one sprint.
 *
 * Before this module, a sprint's verification ran exactly once (`sprint-runner.ts`
 * Step 5): a FAIL went straight to judgment, and the NEXT sprint re-planned from
 * scratch instead of fixing the break. Live run `mu54vrme4c87` shipped nothing
 * across two sprints for exactly this reason — a package downgrade the run itself
 * made broke the build, and new projects were never registered in the solution
 * (zero test coverage) — and neither sprint ever attempted a fix.
 *
 * This module is the bounded reviewer->fixer loop, reusing the SAME shape as
 * `plan-adherence-review.ts` (`runIsolatedGuarded`, a round cap, a no-progress
 * key, a `stopReason`) but for the verify floor instead of plan fidelity:
 *
 *   trigger -> fixer turn -> re-run Step 5's OWN verify+floor routine -> repeat
 *
 * `computeVerifyFixTrigger` decides whether a failure is the kind a code fixer
 * can plausibly repair (a build break this run caused, failing tests, zero test
 * coverage, an actionable FAIL/UNKNOWN) versus a failure that must NOT be
 * "fixed" here — the user's own pre-existing, already-broken build. Trying to
 * repair someone else's unrelated breakage is out of scope and would waste a
 * round on something this run did not cause and cannot honestly claim credit
 * for un-breaking.
 *
 * `runVerifyFixLoop` never re-implements the verify+floor logic — the caller
 * (`sprint-runner.ts`) hands in a `runVerifyPass` callback that is the EXACT
 * same generator Step 5 calls for the sprint's first verification, so a
 * re-verify round runs through one code path, never a fork.
 *
 * ## D2 — a cheap deterministic re-check before paying for another full pass
 *
 * A full pass is a verify sub-agent turn (model calls) PLUS the deterministic
 * floor (real build and test commands) — measured live, about 2.5 minutes,
 * with an 87-second build. Most rounds after the first fail again on the SAME
 * deterministic evidence (the build is still broken, or the same tests still
 * fail): paying for the model turn to learn that is waste.
 *
 * When the round's failure is one the deterministic floor alone can speak to
 * (`isCheapRecheckEligible` — a build break or test regression the floor
 * itself found, never a plain model-narrated `verify_verdict` failure or
 * `zero_coverage`/`project_not_registered`, which need more than build/test
 * exit codes to judge), the loop re-runs ONLY the caller's `runFloorRecheck`
 * callback after the fixer — the SAME floor invocation `runVerifyPass` itself
 * uses (see `runDeterministicFloorOnly` in `sprint-runner.ts`), never a forked
 * copy. Still failing the same deterministic way → the round is recorded as
 * `passKind: "cheap"` and the verify sub-agent is never dispatched that round.
 * The floor now passing → falls through to a full pass exactly as before, so
 * the loop's FINAL result always comes from a full pass (or an earlier one,
 * with an honest `passKind: "cheap"` record for the rounds that didn't).
 * `runFloorRecheck` is optional and MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK=0
 * disables it — either way, every round runs a full pass, byte-identical to
 * pre-D2 behaviour.
 *
 * ## D12 — a timed-out fixer's work is not thrown away
 *
 * A fixer edits files in place; `withDeadlineRace` (`utils/llm-deadline.ts`)
 * never cancels the underlying call on a timeout, it only stops AWAITING it —
 * so whatever the fixer already wrote to disk before the deadline fired is
 * still there. Before this, a timeout was terminal: the round was recorded
 * `fixerSuccess: false` and the loop stopped with `stopReason: "error"`
 * without ever looking at whether those partial edits changed anything (live
 * evidence: run `muauw6u93e1c`, sprint 1 round 1 timed out after 60 sub-agent
 * activity events and stopped outright; sprint 2's round 1 cheap re-check had
 * already found the real cause before round 2 timed out the same way). Now a
 * TIMED-OUT fixer gets the SAME D2 cheap re-check (same eligibility rule, same
 * `runFloorRecheck` callback, never a full pass — this round already spent
 * its fixer budget) before the loop decides to continue on a changed failure,
 * stop on `no_progress` for the same one, or stop on the round cap. The
 * round's record keeps BOTH facts: `fixerSuccess: false` / `fixerSummary`
 * still the timeout message, and `failureKeyAfter` / `passKind: "cheap"` from
 * the re-check — never a fabricated `fixerSuccess: true`. Ineligible for the
 * cheap path (e.g. `zero_coverage`), no `runFloorRecheck`, an inconclusive
 * re-check, or the total deadline already spent all fall through to the
 * pre-D12 timeout-stop, unchanged.
 */

import type { StreamChunk, TaskRequest, ToolResult, VerifyRecipe } from "../types/index.js";
import { classifyCoverage, isVerifiedZeroCoverage } from "./coverage-signal.js";
import { type IsolatedGuardObservation, runIsolatedGuarded } from "./plan-adherence-review.js";
import { hasProjectRegistrationViolations, type ProjectRegistrationCheckResult } from "./project-registration-check.js";
import { boundTaskText } from "./sprint-plan-artifact.js";
import { classifyTestCommands } from "./test-command-signal.js";
import { extractErrorSet, type FloorDelta } from "./verify-baseline.js";
import type { FloorCheck } from "./verify-floor.js";
import type { VerifyVerdict } from "./verify-result.js";

/** `MUONROI_IDEAL_VERIFY_FIX_ROUNDS` (integer >= 0) overrides the default. `0` disables the loop. */
export const DEFAULT_VERIFY_FIX_ROUNDS = 2;

/**
 * Reads and validates `MUONROI_IDEAL_VERIFY_FIX_ROUNDS`, mirroring
 * `getNoProgressSprintLimit` in `sprint-progress.ts`: an unset/blank value
 * falls back to the default silently, but an INVALID one (non-numeric,
 * negative, non-integer) is logged and STILL falls back to the default — never
 * silently coerced to 0, which would look like a deliberate opt-out.
 */
export function getVerifyFixRoundLimit(): number {
  const raw = process.env.MUONROI_IDEAL_VERIFY_FIX_ROUNDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_FIX_ROUNDS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n;
  console.error(
    `[verify-fix-loop] ignoring MUONROI_IDEAL_VERIFY_FIX_ROUNDS=${JSON.stringify(raw)} (needs an integer >= 0); using ${DEFAULT_VERIFY_FIX_ROUNDS}`,
  );
  return DEFAULT_VERIFY_FIX_ROUNDS;
}

/**
 * `MUONROI_IDEAL_VERIFY_FIX_DEADLINE_MS` — total-elapsed cap on the WHOLE loop
 * (every round's fixer call plus its re-verify), not per round. Default 30
 * minutes: `getIsolatedTaskDeadlineMs()` (`utils/llm-deadline.ts`) already
 * treats 1_800_000ms as the longest a SINGLE isolated sub-agent call is ever
 * allowed to run (its own clamp ceiling); this loop can dispatch several such
 * calls across its rounds, so bounding the whole remediation window to that
 * same ceiling keeps it from silently becoming the longest-running thing in
 * the sprint. `/ideal` otherwise has no limits by design (user decision) — this
 * loop is the one place that decision does not apply, because unlike the
 * sprint's main stages it exists specifically to bound EXTRA, opportunistic
 * work on top of a sprint that already finished verifying.
 */
export const DEFAULT_VERIFY_FIX_DEADLINE_MS = 1_800_000;

/**
 * Reads and validates `MUONROI_IDEAL_VERIFY_FIX_DEADLINE_MS`, mirroring
 * `getVerifyFixRoundLimit`: unset/blank falls back to the default silently; an
 * invalid value (non-numeric, non-positive, non-integer) is logged and STILL
 * falls back to the default. Unlike the rounds env, `0` is not a valid
 * "disable" value here — a zero deadline would mean "never run a round at
 * all", which is what `MUONROI_IDEAL_VERIFY_FIX_ROUNDS=0` is already for.
 */
export function getVerifyFixDeadlineMs(): number {
  const raw = process.env.MUONROI_IDEAL_VERIFY_FIX_DEADLINE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_FIX_DEADLINE_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
  console.error(
    `[verify-fix-loop] ignoring MUONROI_IDEAL_VERIFY_FIX_DEADLINE_MS=${JSON.stringify(raw)} (needs a positive integer ms); using ${DEFAULT_VERIFY_FIX_DEADLINE_MS}`,
  );
  return DEFAULT_VERIFY_FIX_DEADLINE_MS;
}

/**
 * D9 — a dedicated wall-clock budget for the fixer's OWN isolated-task call,
 * smaller than the generic `getIsolatedTaskDeadlineMs()` (15 min /
 * 900_000ms) every OTHER isolated task in this codebase shares.
 *
 * Evidence (live run `mu75rurpf9ec`, sprint 1): `sprints/1-verify-fix.json`
 * round 1 recorded `roundElapsedMs: 900009` and `fixerSummary: "verify-fix-
 * s1-r1 exceeded 900000ms deadline (timeout)"` — the fixer spent the FULL
 * generic ceiling doing nothing this loop could observe. The loop's own
 * `startedAt`/`finishedAt` timestamps span exactly 900011ms, meaning that
 * single call was the ENTIRE measured lifetime of the loop: it never reached
 * a re-verify pass, let alone `getVerifyFixRoundLimit()`'s second round. A
 * bounded "verify -> fix -> re-verify" loop whose round cap a single stuck
 * fixer call can silently override is not the loop this module documents
 * itself as being.
 *
 * `plan-adherence-review.ts`'s reviewer/fixer loop shares the SAME generic
 * ceiling per call but has NO total-elapsed deadline of its own (see that
 * module's doc) — bounded only by its round cap, so a slow call there merely
 * costs wall time, never blows through an outer promise. This loop is
 * different: it already promises callers a fixed TOTAL window
 * (`getVerifyFixDeadlineMs()`, default 1_800_000ms/30min) covering EVERY
 * round's fixer call plus its re-verify pass. At the generic 900_000ms
 * ceiling, the default `getVerifyFixRoundLimit()` of 2 rounds could spend the
 * loop's ENTIRE total budget on fixer calls alone (2 x 900_000ms =
 * 1_800_000ms) with zero ms left for either re-verify pass — exactly the
 * failure mode measured above. The fixer needs its own, smaller number here.
 *
 * Default 600_000ms (10 min): at 2 default rounds that reserves at most
 * 1_200_000ms of the 1_800_000ms total for fixer calls, leaving >= 600_000ms
 * for the interleaved re-verify passes — >= 4x the ~150_000ms/2.5min a full
 * verify+floor pass measures per this module's own doc (the D2 section
 * above), so a legitimately full-length pass is never starved by this
 * choice. Override with `MUONROI_IDEAL_VERIFY_FIX_FIXER_MS`; unset/blank
 * falls back to the default silently, an invalid value (non-numeric,
 * non-positive, non-integer) is logged and still falls back — same
 * discipline as `getVerifyFixDeadlineMs`.
 */
export const DEFAULT_VERIFY_FIX_FIXER_DEADLINE_MS = 600_000;

export function getVerifyFixFixerDeadlineMs(): number {
  const raw = process.env.MUONROI_IDEAL_VERIFY_FIX_FIXER_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_FIX_FIXER_DEADLINE_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
  console.error(
    `[verify-fix-loop] ignoring MUONROI_IDEAL_VERIFY_FIX_FIXER_MS=${JSON.stringify(raw)} (needs a positive integer ms); using ${DEFAULT_VERIFY_FIX_FIXER_DEADLINE_MS}`,
  );
  return DEFAULT_VERIFY_FIX_FIXER_DEADLINE_MS;
}

/**
 * D2 — `MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK=0` restores today's
 * always-full behaviour byte-identically: every round runs the complete
 * verify pass (verify sub-agent turn + floor), same as before this feature
 * existed. Default ON, mirroring the other verify-fix env gates' "on unless
 * explicitly disabled" convention.
 */
export function isCheapRecheckEnabled(): boolean {
  const raw = process.env.MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK;
  return raw !== "0";
}

/**
 * D2 — the failure reasons the deterministic floor ALONE can re-confirm or
 * refute: a build break or test failure the floor itself attributed. Every
 * other reason needs more than the floor's exit codes to judge —
 * `zero_coverage` needs the verify sub-agent's own recipe/coverage read,
 * `project_not_registered` needs the structure check (not run by the cheap
 * recheck), and a plain `verify_verdict` failure IS the sub-agent's own
 * narration, which by definition only the sub-agent can re-confirm. A
 * combined identity (`withStructureViolation`'s `+project_not_registered`
 * suffix) is deliberately excluded too — an exact-string match, not a prefix
 * check, so a build fix that leaves a registration violation unresolved
 * still gets a full pass to re-evaluate the whole picture.
 */
const CHEAP_RECHECK_REASONS: ReadonlySet<string> = new Set([
  "build_run_introduced",
  "build_unattributable",
  "test_regression",
  "test_unattributable",
  "test_absolute_no_baseline",
  "no_tests_executed",
]);

/** D2 — see `CHEAP_RECHECK_REASONS`. */
export function isCheapRecheckEligible(identity: FailureIdentity): boolean {
  return identity.failedCondition === "engineering_floor" && CHEAP_RECHECK_REASONS.has(identity.reason);
}

/**
 * D2 — one deterministic-floor-only re-check, run before paying for a full
 * verify pass. Deliberately a plain `Promise`, not a generator: unlike
 * `runVerifyPass` it has no sub-agent phase to stream progress chunks for,
 * only the floor's own (already-logged) command output.
 */
export interface FloorRecheckOutcome {
  /**
   * False when the floor itself produced no evidence this round (spawn
   * failure, or genuinely no commands to run) — treated as inconclusive, so
   * the loop falls through to a full pass rather than guessing.
   */
  ranOk: boolean;
  floorDelta?: FloorDelta;
  floorChecks?: FloorCheck[];
  /** See `VerifyPassOutcome.floorDetail` — folded into `cur` alongside the checks. */
  floorDetail?: string;
  floorMustFixNote?: string;
}

/**
 * One verify+floor pass's outcome — the exact shape Step 5 already produces.
 * `floorChecks` is the floor's raw per-command evidence (needed to pull a
 * build failure's `errorSet` for the failure key; `FloorDelta` itself does not
 * carry it). `recipeFromVerify` mirrors sprint-runner's own naming.
 */
export interface VerifyPassOutcome {
  verifyResult: ToolResult;
  verifyVerdict: VerifyVerdict;
  recipeFromVerify: VerifyRecipe | null;
  floorDelta?: FloorDelta;
  floorChecks?: FloorCheck[];
  /**
   * The floor's own formatted per-command record for this pass (`- [build] … →
   * OK (Nms)`, `Rule applied: …`), carried so the sprint artifact can preserve
   * the MEASUREMENT independently of the verdict. Not read by any decision in
   * this module — a record, not a signal.
   */
  floorDetail?: string;
  floorMustFixNote?: string;
  /**
   * S6 — `project-registration-check.ts`'s result for this pass: whether a
   * newly created project manifest is registered in its ecosystem's solution/
   * workspace index. Independent of `floorDelta` — a repo's own build/test
   * gates can PASS while a new project sits outside the solution entirely
   * (invisible to `dotnet test`, not a build/test failure at all). See
   * `computeVerifyFixTrigger`'s `structureCheck` handling below.
   */
  structureCheck?: ProjectRegistrationCheckResult;
}

/**
 * What a failure IS, in a vocabulary the fix loop owns — never done-gate's own
 * strings, since this module runs BEFORE the done-gate and must not imply an
 * equivalence that does not hold. `errorSet` is always sorted, so the same
 * failure produces the same key regardless of output ordering.
 */
export interface FailureIdentity {
  failedCondition: "engineering_floor" | "verify_verdict";
  reason: string;
  errorSet: string[];
}

/** Pull the failed build check's own `errorSet`, when the floor recorded one. */
function buildFailureErrorSet(delta: FloorDelta, checks: FloorCheck[] | undefined): string[] {
  if (!checks) return [];
  const failed = checks.find((c) => c.kind === "build" && c.command === delta.failedCommand && !c.ok);
  return failed?.errorSet ? [...failed.errorSet].sort() : [];
}

/**
 * The `verify_verdict` fallback identity's `errorSet` — reuses S5's
 * `extractErrorSet` (normalized build/typecheck error-code lines: `NU####`,
 * `CS####`, `TS####`, `MSB####`) against the verify output, UNIONED with any
 * failing test names the floor already parsed (`floorChecks[].failingTests`),
 * when a floor ran at all in this branch (it can: a self-verify/goal-gate
 * downgrade after a floor PASS still lands here with `floorChecks` set).
 * Neither source is free text — both are structured identifiers — so this
 * keeps the no-progress key free-text-free. Can still come back empty (plain
 * assertion-failure prose matches neither), which `deriveFailureIdentity`'s
 * caller must treat as UNDECIDABLE, never as a stable "same failure" key.
 */
function verifyVerdictErrorSet(verifyOutput: string, floorChecks: FloorCheck[] | undefined): string[] {
  const fromOutput = extractErrorSet(verifyOutput);
  const fromTests = floorChecks?.flatMap((c) => c.failingTests ?? []) ?? [];
  return [...new Set([...fromOutput, ...fromTests])].sort();
}

/**
 * S6 — the sorted, deduplicated manifest paths behind every GENUINE violation
 * (`solutionFile` set — never an ambiguous/parse-failure entry, which carries
 * no actionable path). This IS the identity's `errorSet` for a registration
 * violation: registering 1 of 2 unregistered projects removes one path from
 * this set, so `computeFailureKey` sees a different key and correctly reads
 * that as PROGRESS rather than "the same failure recurred" — the acceptance
 * review's blocker #2 (an empty `errorSet` made partial registration
 * indistinguishable from no progress at all).
 */
function structureManifestErrorSet(structureCheck: ProjectRegistrationCheckResult | undefined): string[] {
  if (!structureCheck) return [];
  const paths = structureCheck.ecosystems
    .filter((e) => e.status === "violations")
    .flatMap((e) => e.unregistered.filter((u) => u.solutionFile).map((u) => u.manifest));
  return [...new Set(paths)].sort();
}

/**
 * S6 — fold a registration violation into an ALREADY-COMPUTED identity rather
 * than replacing it, so a build failure and a registration violation that
 * coexist both stay visible in the key: `reason` gets a deterministic
 * `+project_not_registered` suffix and `errorSet` becomes the union of the
 * base identity's own errors and the unregistered manifest paths. Either side
 * changing (a build error fixed, or one more project registered) changes the
 * combined key, so neither side's progress can mask the other's — the
 * acceptance review's blocker #2, the coexistence case.
 */
function withStructureViolation(base: FailureIdentity, structureManifests: readonly string[]): FailureIdentity {
  if (structureManifests.length === 0) return base;
  return {
    failedCondition: base.failedCondition,
    reason: `${base.reason}+project_not_registered`,
    errorSet: [...new Set([...base.errorSet, ...structureManifests])].sort(),
  };
}

/**
 * Derive the failure's identity from what Step 5's routine already computed —
 * never from free-form text. Build failures with no baseline confirmation of
 * "already broken" (`buildAlreadyBroken === false`) are treated as this run's
 * own regression: a baseline that recorded a good build is authoritative
 * evidence the run broke it, same as an explicit `run-introduced` attribution.
 */
export function deriveFailureIdentity(input: {
  verifyVerdict: VerifyVerdict;
  floorDelta?: FloorDelta;
  floorChecks?: FloorCheck[];
  recipe: VerifyRecipe | null;
  /** Required for the `verify_verdict` fallback's errorSet extraction. */
  verifyOutput: string;
  /** S6 — see `VerifyPassOutcome.structureCheck`. */
  structureCheck?: ProjectRegistrationCheckResult;
}): FailureIdentity {
  const { verifyVerdict, floorDelta, floorChecks, recipe, verifyOutput, structureCheck } = input;
  const structureManifests = structureManifestErrorSet(structureCheck);
  const structureViolated = structureManifests.length > 0;

  // A build failure the floor could only call pre-existing is not this run's
  // doing (see computeVerifyFixTrigger's own skip rule for the pure case) —
  // it must never be blended into the identity, or fixing an UNRELATED
  // registration violation would look like it also touched a build break
  // nobody asked this run to fix. `computeVerifyFixTrigger` only reaches this
  // function for a pre-existing-only build when `structureViolated` is ALSO
  // true (its own skip already covers the pure pre-existing case), so falling
  // through to the plain structure/verify_verdict branches below is correct
  // here, not merely defensive.
  const buildExcused =
    floorDelta?.verdict === "fail" &&
    floorDelta.failureKind === "build-failed" &&
    floorDelta.buildAlreadyBroken === true &&
    floorDelta.buildAttribution === "pre-existing";

  if (floorDelta?.verdict === "fail" && !buildExcused) {
    switch (floorDelta.failureKind) {
      case "build-failed": {
        const reason =
          floorDelta.buildAlreadyBroken === true && floorDelta.buildAttribution === "unattributable"
            ? "build_unattributable"
            : "build_run_introduced";
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason, errorSet: buildFailureErrorSet(floorDelta, floorChecks) },
          structureManifests,
        );
      }
      case "no-tests-executed":
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason: "no_tests_executed", errorSet: [] },
          structureManifests,
        );
      case "test-regression":
        return withStructureViolation(
          {
            failedCondition: "engineering_floor",
            reason: "test_regression",
            errorSet: [...floorDelta.newlyFailing].sort(),
          },
          structureManifests,
        );
      case "test-unattributable":
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason: "test_unattributable", errorSet: [] },
          structureManifests,
        );
      case "test-absolute-no-baseline":
        return withStructureViolation(
          {
            failedCondition: "engineering_floor",
            reason: "test_absolute_no_baseline",
            errorSet: [...floorDelta.newlyFailing].sort(),
          },
          structureManifests,
        );
      // An un-runnable gate is an ENVIRONMENT fact, so it gets its own reason
      // rather than falling to `unknown`. Routing it to a test/build reason
      // would send the fix loop after code that is fine — the same
      // misattribution the `gate-could-not-run` kind exists to end.
      case "gate-could-not-run":
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason: "gate_could_not_run", errorSet: [] },
          structureManifests,
        );
      case "infra":
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason: "infra", errorSet: [] },
          structureManifests,
        );
      default:
        return withStructureViolation(
          { failedCondition: "engineering_floor", reason: "unknown", errorSet: [] },
          structureManifests,
        );
    }
  }

  // S6 — a new project not registered in its solution is a deterministic,
  // unambiguous fact independent of the floor's own verdict (the floor can
  // PASS while the new project's tests never ran at all — that is exactly
  // what "not registered" means). Checked before the zero_coverage/verify_
  // verdict fallbacks below because it is usually their ROOT CAUSE in the
  // exact scenario this module closes (an unregistered project's tests never
  // run at all, which IS zero coverage) — the more specific, actionable
  // signal wins rather than being silently absorbed into a generic one.
  if (structureViolated) {
    return { failedCondition: "engineering_floor", reason: "project_not_registered", errorSet: structureManifests };
  }

  // THE THIRD READER of `coverage`, and it used to carry the coercion the other
  // two had already removed: `(recipe?.coverage ?? 0) > 0` reads "nobody measured
  // coverage" as "coverage is zero", which is the exact defect
  // `coverage-signal.ts` was written to delete. It now uses the same predicate
  // the done-gate uses, so only a zero the FLOOR actually measured names this
  // failure.
  //
  // WHICH PREDICATE AND WHY (the module asks a third caller to say): the
  // consequence here matches the done-gate's, not CB-3's — a fix round spent on
  // an invented failure is silent and self-repeating, nothing prompts the user,
  // and the fixer is sent after coverage that may already exist. So
  // `isVerifiedZeroCoverage`, never `isClaimedZeroCoverage`.
  //
  // This became urgent rather than merely wrong in the same change that unioned
  // the disk-derived test commands into the recipe: before it, a project whose
  // recipe carried `testCommands: []` (qa-platform's stored
  // `.muonroi-cli/environment.json`) made `hasTests` false and this branch
  // unreachable. Afterwards `hasTests` is true and `coverage` is null, so a
  // sprint whose own gates went GREEN would have burned a round on `zero_coverage`.
  const hasTests = classifyTestCommands(recipe).state === "present";
  const coverageIsZero = isVerifiedZeroCoverage(classifyCoverage(recipe));
  if (hasTests && coverageIsZero) {
    return { failedCondition: "engineering_floor", reason: "zero_coverage", errorSet: [] };
  }

  return {
    failedCondition: "verify_verdict",
    reason: verifyVerdict,
    errorSet: verifyVerdictErrorSet(verifyOutput, floorChecks),
  };
}

/**
 * True when an identity's key cannot be trusted to prove "the exact same
 * failure recurred" — only the `verify_verdict` fallback with an EMPTY
 * errorSet (no recognizable error code, no parsed failing test name). Two
 * rounds landing here produce the SAME key (`verify_verdict:<V>:`) even when
 * the underlying problem changed, so a key match in this state must not be
 * read as no-progress — see `runVerifyFixLoop`'s `noProgressUndecidable`.
 */
export function isFailureKeyUndecidable(identity: FailureIdentity): boolean {
  return identity.failedCondition === "verify_verdict" && identity.errorSet.length === 0;
}

/**
 * The no-progress key — built ONLY from `failedCondition` + `reason` + the
 * sorted `errorSet`, NEVER free text (a model rephrasing its own narration
 * between rounds must not defeat the no-progress stop). Mirrors the same
 * discipline `plan-adherence-review.ts`'s `deviationKey` already applies to
 * task ids + the reviewer's own `deviation` field.
 */
export function computeFailureKey(identity: FailureIdentity): string {
  return `${identity.failedCondition}:${identity.reason}:${identity.errorSet.join(",")}`;
}

export type VerifyFixSkipReason = "pre_existing_build_only" | "not_actionable";

export interface VerifyFixTriggerResult {
  shouldRun: boolean;
  identity?: FailureIdentity;
  skippedReason?: VerifyFixSkipReason;
}

/**
 * Decide whether this sprint's failure is one a code fixer can plausibly
 * repair. See the module doc for the full trigger/skip rule; the one hard
 * SKIP is a build failure the floor could only honestly call `pre-existing`
 * (`describeBuildMustFix`'s own rule in `verify-baseline.ts`) — repairing the
 * user's own already-broken build is out of scope for this run.
 */
export function computeVerifyFixTrigger(input: {
  verifyVerdict: VerifyVerdict;
  floorDelta?: FloorDelta;
  floorChecks?: FloorCheck[];
  recipe: VerifyRecipe | null;
  verifyOutput: string;
  /** S6 — see `VerifyPassOutcome.structureCheck`. Triggers the loop even when the floor passed. */
  structureCheck?: ProjectRegistrationCheckResult;
}): VerifyFixTriggerResult {
  const { verifyVerdict, floorDelta, recipe, verifyOutput, structureCheck } = input;

  // S6 — checked first and unconditionally: a violation here is actionable and
  // deterministic on its own, so it must trigger the loop even when the floor
  // PASSED and the recipe reports coverage (the very scenario this closes —
  // run mu54vrme4c87, both sprints scored `zero_coverage` and neither sprint
  // ever attempted a fix).
  if (hasProjectRegistrationViolations(structureCheck)) {
    return { shouldRun: true, identity: deriveFailureIdentity(input) };
  }

  // A floor SKIP must not silence the model's own positive FAIL claim.
  //
  // The two skip returns below ("the user's build was already broken", "an
  // un-runnable gate is not something a code fixer can close") both reason about
  // what the FLOOR found. Until the floor ran on a model-reported FAIL they could
  // never collide with one: the floor was gated on `PASS || UNKNOWN`, so a FAIL
  // always fell through to the verify-verdict trigger further down and the loop
  // ran. Now that the floor runs on every verdict, a floor skip would pre-empt
  // that fall-through and cancel the fix round for a failure the floor never
  // spoke to — the sub-agent's FAIL is about something else (in run
  // muc2joffe506 sprint 1, a Phase 3 app start no floor command executes).
  //
  // So the skip is declined when the model itself reported FAIL with output to
  // act on — the exact condition the verify-verdict trigger below uses, stated
  // here so the two cannot drift. UNKNOWN is deliberately NOT included: the floor
  // has always run for it, so its skips are established behaviour, and an absent
  // claim gives the fixer nothing the floor has not already ruled out.
  const modelClaimedFailure = verifyVerdict === "FAIL" && verifyOutput.trim().length > 0;

  if (floorDelta?.verdict === "fail" && floorDelta.failureKind === "build-failed") {
    if (floorDelta.buildAlreadyBroken === true && floorDelta.buildAttribution === "pre-existing") {
      if (modelClaimedFailure) return { shouldRun: true, identity: deriveFailureIdentity(input) };
      return { shouldRun: false, skippedReason: "pre_existing_build_only" };
    }
    return { shouldRun: true, identity: deriveFailureIdentity(input) };
  }

  if (floorDelta?.verdict === "fail") {
    switch (floorDelta.failureKind) {
      case "test-regression":
      case "test-unattributable":
      case "test-absolute-no-baseline":
      case "no-tests-executed":
        return { shouldRun: true, identity: deriveFailureIdentity(input) };
      // Stated explicitly rather than left to `default`: a gate that could not
      // RUN is an environment fact, and the floor deliberately does not install
      // anything (verify-floor.ts "What is deliberately NOT run"), so a code
      // fixer cannot close it — spending a fix round here is the churn that
      // burned $1.405 for zero progress on run muc2joffe506. The cause still
      // reaches the next sprint as the `gate_could_not_run` carry-over reason,
      // where the implementation turn CAN declare the missing dependency in the
      // project's manifest.
      case "gate-could-not-run":
        if (modelClaimedFailure) return { shouldRun: true, identity: deriveFailureIdentity(input) };
        return { shouldRun: false, skippedReason: "not_actionable" };
      default:
        // "infra" (spawn error / timeout) — no evidence a code fixer can act on.
        break;
    }
  }

  // Same terms as `deriveFailureIdentity`'s zero-coverage branch, and they MUST
  // stay the same: this decides whether to spend a round, that names what the
  // round is for, and a trigger that fires on a failure the identity would not
  // call `zero_coverage` sends the fixer after nothing. See the full argument at
  // that branch — in short, only a zero the FLOOR measured is a finding, and an
  // unmeasured suite is not an uncovered one.
  const hasTests = classifyTestCommands(recipe).state === "present";
  const coverageIsZero = isVerifiedZeroCoverage(classifyCoverage(recipe));
  if (hasTests && coverageIsZero) {
    return { shouldRun: true, identity: deriveFailureIdentity(input) };
  }

  if ((verifyVerdict === "FAIL" || verifyVerdict === "UNKNOWN") && verifyOutput.trim().length > 0) {
    return { shouldRun: true, identity: deriveFailureIdentity(input) };
  }

  return {
    shouldRun: false,
    skippedReason: verifyVerdict === "FAIL" || verifyVerdict === "UNKNOWN" ? "not_actionable" : undefined,
  };
}

const MAX_SUMMARY_CHARS = 600;
const VERIFY_TAIL_MAX_CHARS = 6000;
const PLAN_MAX_CHARS = 6000;

function bound(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function verifyOutputOf(tr: ToolResult): string {
  return (tr.error?.trim() ? tr.error : (tr.output ?? "")).trim();
}

/**
 * D12 — the exact shape `withDeadlineRace` (`utils/llm-deadline.ts`) stamps on
 * a timeout: `` `${label} exceeded ${deadlineMs}ms deadline (timeout)` ``.
 * `runIsolatedGuarded` (`plan-adherence-review.ts`) catches that rejection and
 * returns it as `ToolResult.error` rather than throwing, so a fixer round's
 * `!fixResult.success` branch is where a timeout is actually observed — never
 * a thrown error. Matched by pattern, not a plain `.includes("timeout")`,
 * so a fixer that legitimately reports failure with the word "timeout" in its
 * own prose (e.g. describing a flaky test) is not mistaken for this specific,
 * structured deadline message.
 */
const FIXER_DEADLINE_TIMEOUT_PATTERN = /exceeded \d+ms deadline \(timeout\)/;

/** D12 — see `FIXER_DEADLINE_TIMEOUT_PATTERN`. */
export function isFixerTimeoutFailure(error: string | undefined): boolean {
  return typeof error === "string" && FIXER_DEADLINE_TIMEOUT_PATTERN.test(error);
}

/**
 * The fixer's prompt. New text — no existing prompt in the codebase is
 * reworded to build this. Bounded: a verify tail, the floor's must-fix note
 * (carries the attribution sentence from `describeBuildMustFix`), the failure's
 * own error set, the sprint's still-open tasks, and the approved plan.
 *
 * D12 — added (not reworded) one line asking for small increments and an
 * early stop once a concrete fix is applied. Evidence: both observed live
 * timeouts (run `muauw6u93e1c`, sprints 1 and 2) ran their FULL fixer
 * deadline with dozens of activity events (60, then 48) and no completion —
 * sprint 2's own cheap re-check right before the second timeout had already
 * found the real cause ("the class is internal but used from the test
 * assembly, needs InternalsVisibleTo"), yet the following round still ran out
 * the clock instead of applying that one fix and stopping. Nothing here
 * changes what the fixer is asked to FIX, only how it is asked to work.
 */
export function buildFixPrompt(args: {
  sprintN: number;
  round: number;
  identity: FailureIdentity;
  verifyTail: string;
  mustFix?: string;
  openTasks: string[];
  planSynthesis: string;
}): string {
  const taskLines =
    args.openTasks.length > 0
      ? args.openTasks.map((t, i) => `${i + 1}. ${boundTaskText(t)}`).join("\n")
      : "(no open tasks recorded)";
  const errorLines =
    args.identity.errorSet.length > 0 ? `Errors:\n${args.identity.errorSet.map((e) => `- ${e}`).join("\n")}\n` : "";
  const mustFixBlock = args.mustFix ? `\n=== MUST FIX ===\n${args.mustFix}\n` : "";
  return (
    `Sprint ${args.sprintN}'s verification FAILED (fix round ${args.round}). Fix the underlying problem by ` +
    `editing the code — do not narrate or re-plan.\n\n` +
    `Work in small, concrete edits. As soon as you have applied a complete fix for the ` +
    `failure below, STOP — do not keep exploring, refactoring, or making further changes.\n\n` +
    `=== FAILURE ===\n` +
    `Condition: ${args.identity.failedCondition}\n` +
    `Reason: ${args.identity.reason}\n` +
    errorLines +
    mustFixBlock +
    `\n=== VERIFY OUTPUT (tail) ===\n${args.verifyTail.slice(-VERIFY_TAIL_MAX_CHARS)}\n` +
    `\n=== OPEN SPRINT TASKS ===\n${taskLines}\n` +
    `\n=== APPROVED PLAN (for reference) ===\n${args.planSynthesis.slice(0, PLAN_MAX_CHARS)}\n`
  );
}

export type VerifyFixStopReason =
  | "not_triggered"
  | "disabled"
  | "pass"
  | "no_progress"
  | "round_cap"
  | "error"
  | "aborted"
  | "deadline";

export interface VerifyFixRoundRecord {
  round: number;
  failureKeyBefore: string;
  fixerRan: boolean;
  fixerSuccess?: boolean;
  /** Bounded to `MAX_SUMMARY_CHARS` — the fixer's own output/error text, never invented. */
  fixerSummary?: string;
  verifyVerdictAfter: VerifyVerdict;
  failureKeyAfter: string;
  /**
   * True when this round's post-fix failure key came from the `verify_verdict`
   * fallback with an EMPTY errorSet (`isFailureKeyUndecidable`) — the key
   * cannot prove "the same failure recurred", so a repeat of it was NOT
   * treated as no-progress this round. Absent (never `false`) on every other
   * round — only the undecidable case is worth recording.
   */
  noProgressUndecidable?: boolean;
  /**
   * D2 — `"cheap"` when this round only re-ran the deterministic floor (no
   * verify sub-agent turn); `"full"` when the complete verify pass ran
   * (today's only behaviour pre-D2, and still the default for every path
   * that isn't the new cheap branch — an error/abort/deadline round never
   * attempted the cheap path either, so it is recorded `"full"` too).
   * Optional so an older on-disk record (written before this field existed)
   * still round-trips unchanged.
   */
  passKind?: "cheap" | "full";
  /**
   * D2 — wall-clock ms this round's fixer dispatch plus its re-check (cheap
   * floor-only, or the full verify pass) took, measured with the loop's own
   * `nowFn` (real `Date.now` in production, injectable in tests). Optional
   * for the same round-trip reason as `passKind`.
   */
  roundElapsedMs?: number;
}

export interface VerifyFixLoopResult {
  /** False only when the round cap resolved to 0 (the loop was opted out of). */
  enabled: boolean;
  /** True once `computeVerifyFixTrigger` decided this sprint's failure was fixable. */
  triggered: boolean;
  skippedReason?: VerifyFixSkipReason;
  rounds: VerifyFixRoundRecord[];
  stopReason: VerifyFixStopReason;
  /** The final verify+floor outcome — PASS after a fix, or the last FAIL/UNKNOWN reached. */
  final: VerifyPassOutcome;
}

export interface RunVerifyFixLoopArgs {
  sprintN: number;
  /** The plan text handed to the fixer for reference — never re-planned, only fixed against. */
  planSynthesis: string;
  /** Titles/ids of sprint tasks not yet marked done, for fixer context. May be empty. */
  openTasks: string[];
  fixModelId: string;
  runIsolatedTask?: (req: TaskRequest) => Promise<ToolResult>;
  /** Step 5's own first verify+floor outcome — the loop's starting point. */
  initial: VerifyPassOutcome;
  /**
   * Step 5's OWN verify+floor generator, called again for each re-verify round.
   * `roundLabel` is passed through only for phase/event labelling; the logic
   * inside is identical on every call — this is what keeps the loop from
   * forking the verification logic.
   */
  runVerifyPass: (roundLabel: string) => AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown>;
  /** Test-only override for `getVerifyFixRoundLimit()`. */
  maxRounds?: number;
  /** Test-only override for `getVerifyFixDeadlineMs()`. */
  maxTotalMs?: number;
  /** D9 — test-only override for `getVerifyFixFixerDeadlineMs()`, the
   * fixer's own dedicated (smaller) per-call budget. */
  maxFixerMs?: number;
  /** Test-only clock injection. Defaults to `Date.now`. */
  nowFn?: () => number;
  /**
   * Checked before each round and between the fixer and the re-verify; an
   * already-aborted signal stops the loop immediately. This is the sprint's
   * REAL production abort signal (`this.abortController.signal` in
   * `orchestrator.ts`, threaded through `DriverContext.abortSignal` —
   * `product-loop/types.ts`), not a new mechanism: it is what already stops a
   * pending `ctx.runIsolatedTask` call and the top-level `/ideal` generator;
   * this loop just gets to check it synchronously between its own awaits too.
   */
  abortSignal?: AbortSignal;
  /**
   * Called synchronously right before a round's fixer is dispatched. The
   * caller (`sprint-runner.ts`) uses this to emit its own `sprint-stage`
   * harness event (`stage: "implementation"` — the fixer is editing code,
   * the same class of work as the sprint's main implementation stage; no new
   * stage kind was added for this) without this module needing to know about
   * `ctx`/`__muonroiAgentRuntime`.
   */
  onRoundStart?: (round: number) => void;
  /**
   * D2 — the cheap deterministic re-check, run after the fixer and BEFORE
   * `runVerifyPass` when `isCheapRecheckEligible` says the round's failure is
   * one the floor alone can speak to. The caller (`sprint-runner.ts`) wires
   * this to the SAME floor invocation `runVerifyPass` uses internally
   * (`runDeterministicFloorOnly`) — one function, two callers, never a
   * forked copy. Absent → every round runs a full pass, today's behaviour.
   *
   * D12 — also the callback a fixer TIMEOUT re-checks with, before giving up
   * on the round. Same eligibility rule, same callback, same "absent → no
   * change from before D12/D2" fallback.
   */
  runFloorRecheck?: (roundLabel: string) => Promise<FloorRecheckOutcome>;
}

/**
 * The bounded verify -> fix -> re-verify loop. Stops on: pass (the trigger no
 * longer fires), no progress (the same DECIDABLE failure key twice in a row —
 * see `isFailureKeyUndecidable`), the round cap, the total-elapsed deadline,
 * an error (no isolated-task capability, the fixer throws, the fixer reports
 * failure, or re-verification itself throws), or an aborted signal.
 *
 * Never throws — every failure path is converted into `stopReason: "error"`
 * with the failure logged, so a fixer/verify crash never derails the sprint
 * that called this loop.
 */
export async function* runVerifyFixLoop(
  args: RunVerifyFixLoopArgs,
): AsyncGenerator<StreamChunk, VerifyFixLoopResult, unknown> {
  const limit = typeof args.maxRounds === "number" ? args.maxRounds : getVerifyFixRoundLimit();
  const deadlineMs = typeof args.maxTotalMs === "number" ? args.maxTotalMs : getVerifyFixDeadlineMs();
  // D9 — the fixer's own dedicated (smaller) per-call budget; see
  // `getVerifyFixFixerDeadlineMs`'s doc for why the generic isolated-task
  // ceiling is wrong for THIS call site specifically.
  const fixerDeadlineMs = typeof args.maxFixerMs === "number" ? args.maxFixerMs : getVerifyFixFixerDeadlineMs();
  const now = args.nowFn ?? Date.now;
  const loopStartedAt = now();
  const deadlineExceeded = (): boolean => now() - loopStartedAt >= deadlineMs;
  let cur = args.initial;

  const trigger = computeVerifyFixTrigger({
    verifyVerdict: cur.verifyVerdict,
    floorDelta: cur.floorDelta,
    floorChecks: cur.floorChecks,
    recipe: cur.recipeFromVerify,
    verifyOutput: verifyOutputOf(cur.verifyResult),
    structureCheck: cur.structureCheck,
  });

  if (limit <= 0) {
    return {
      enabled: false,
      triggered: trigger.shouldRun,
      skippedReason: trigger.skippedReason,
      rounds: [],
      stopReason: "disabled",
      final: cur,
    };
  }

  if (!trigger.shouldRun) {
    if (trigger.skippedReason === "pre_existing_build_only") {
      yield {
        type: "content",
        content: `\n> [verify-fix] Sprint ${args.sprintN}: build failure is pre-existing (not this run's doing) — skipping the fix loop.\n`,
      };
    }
    return {
      enabled: true,
      triggered: false,
      skippedReason: trigger.skippedReason,
      rounds: [],
      stopReason: "not_triggered",
      final: cur,
    };
  }

  if (!args.runIsolatedTask) {
    console.error(
      `[verify-fix-loop] sprint ${args.sprintN}: fix loop triggered (${trigger.identity?.reason}) but no isolated-task capability is available — cannot run a fix round`,
    );
    yield {
      type: "content",
      content: `\n> [verify-fix] Sprint ${args.sprintN}: no isolated-task capability — cannot run a fix round.\n`,
    };
    return { enabled: true, triggered: true, rounds: [], stopReason: "error", final: cur };
  }

  const rounds: VerifyFixRoundRecord[] = [];
  let previousKey = computeFailureKey(trigger.identity!);
  let stopReason: VerifyFixStopReason = "round_cap";

  for (let round = 1; round <= limit; round++) {
    if (args.abortSignal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (deadlineExceeded()) {
      yield {
        type: "content",
        content: `\n> [verify-fix] Sprint ${args.sprintN}: total-elapsed deadline reached before round ${round}; stopping.\n`,
      };
      stopReason = "deadline";
      break;
    }

    // D2 — measures the whole round (fixer dispatch + its re-check, cheap or
    // full), using the loop's own `nowFn` so tests can inject a clock the
    // same way `deadlineExceeded` already does.
    const roundClockStart = now();

    const identityBefore = deriveFailureIdentity({
      verifyVerdict: cur.verifyVerdict,
      floorDelta: cur.floorDelta,
      floorChecks: cur.floorChecks,
      recipe: cur.recipeFromVerify,
      verifyOutput: verifyOutputOf(cur.verifyResult),
      structureCheck: cur.structureCheck,
    });
    const keyBefore = computeFailureKey(identityBefore);

    try {
      args.onRoundStart?.(round);
    } catch (err) {
      console.error(
        `[verify-fix-loop] onRoundStart callback threw (sprint ${args.sprintN}, round ${round}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    yield {
      type: "content",
      content: `\n> [verify-fix] Round ${round}: dispatching a fix for sprint ${args.sprintN} (${identityBefore.reason})…\n`,
    };

    // D9 — filled in as the fixer's isolated task reports per-tool activity;
    // read AFTER the call settles so a timeout's error message can say WHAT
    // was last observed, not only how long the call ran.
    const fixObservation: IsolatedGuardObservation = { events: 0, lastEventAtMs: null };
    let fixResult: ToolResult;
    try {
      fixResult = await runIsolatedGuarded(
        args.runIsolatedTask,
        {
          agent: "general",
          description: `Sprint ${args.sprintN} verify-fix (round ${round})`,
          prompt: buildFixPrompt({
            sprintN: args.sprintN,
            round,
            identity: identityBefore,
            verifyTail: verifyOutputOf(cur.verifyResult),
            mustFix: cur.floorMustFixNote,
            openTasks: args.openTasks,
            planSynthesis: args.planSynthesis,
          }),
          modelId: args.fixModelId,
        },
        `verify-fix-s${args.sprintN}-r${round}`,
        { deadlineMs: fixerDeadlineMs, abortSignal: args.abortSignal, observation: fixObservation },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[verify-fix-loop] fixer threw (sprint ${args.sprintN}, round ${round}): ${message}`, {
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
      rounds.push({
        round,
        failureKeyBefore: keyBefore,
        fixerRan: true,
        fixerSuccess: false,
        fixerSummary: bound(message, MAX_SUMMARY_CHARS),
        verifyVerdictAfter: cur.verifyVerdict,
        failureKeyAfter: keyBefore,
        passKind: "full",
        roundElapsedMs: now() - roundClockStart,
      });
      stopReason = "error";
      break;
    }

    // Checked between the fixer and the re-verify — this is exactly the gap
    // the fix loop introduced: without it, a sprint whose consumer already
    // aborted (or whose deadline already elapsed) would still pay for another
    // full verify+floor pass before the next round-top check ever ran.
    if (args.abortSignal?.aborted || deadlineExceeded()) {
      const reason: VerifyFixStopReason = args.abortSignal?.aborted ? "aborted" : "deadline";
      rounds.push({
        round,
        failureKeyBefore: keyBefore,
        fixerRan: true,
        fixerSuccess: fixResult.success,
        fixerSummary: bound(
          fixResult.success ? (fixResult.output ?? "applied") : (fixResult.error ?? "fix failed"),
          MAX_SUMMARY_CHARS,
        ),
        verifyVerdictAfter: cur.verifyVerdict,
        failureKeyAfter: keyBefore,
        passKind: "full",
        roundElapsedMs: now() - roundClockStart,
      });
      stopReason = reason;
      break;
    }

    if (!fixResult.success) {
      const fixerSummary = bound(fixResult.error ?? "fix failed", MAX_SUMMARY_CHARS);

      // D12 — a fixer edits files in place: `withDeadlineRace` (`utils/
      // llm-deadline.ts`) never cancels the underlying call on a timeout, it
      // only stops AWAITING it, so whatever the fixer already wrote to disk
      // before the deadline fired is still there. Treating every timeout as a
      // dead end throws that work away without ever looking at it. Re-run the
      // SAME cheap deterministic floor re-check D2 already uses (never a full
      // pass — this round already spent its fixer budget) so the loop can see
      // whether the timeout's partial edits actually changed the failure
      // before deciding to continue, stop on no-progress, or stop on the
      // round cap. Gated exactly like D2's own cheap path (same eligibility,
      // same enable flag, same `runFloorRecheck` callback) plus a fresh
      // deadline check, since this round already spent time waiting on the
      // fixer.
      const timedOut = isFixerTimeoutFailure(fixResult.error);
      const runFloorRecheck = args.runFloorRecheck;
      const canRecheckAfterTimeout =
        timedOut &&
        isCheapRecheckEnabled() &&
        runFloorRecheck !== undefined &&
        isCheapRecheckEligible(identityBefore) &&
        !deadlineExceeded();

      if (canRecheckAfterTimeout && runFloorRecheck !== undefined) {
        yield {
          type: "content",
          content: `\n> [verify-fix] Round ${round}: fixer timed out; re-checking the deterministic floor before deciding.\n`,
        };
        let cheap: FloorRecheckOutcome | undefined;
        try {
          cheap = await runFloorRecheck(`fix-r${round}-timeout-recheck`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[verify-fix-loop] post-timeout floor re-check threw (sprint ${args.sprintN}, round ${round}): ${message}`,
            { stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined },
          );
          cheap = undefined;
        }

        if (cheap?.ranOk) {
          const cheapIdentity = deriveFailureIdentity({
            verifyVerdict: cur.verifyVerdict,
            floorDelta: cheap.floorDelta,
            floorChecks: cheap.floorChecks,
            recipe: cur.recipeFromVerify,
            verifyOutput: verifyOutputOf(cur.verifyResult),
            structureCheck: cur.structureCheck,
          });
          if (cheapIdentity.failedCondition === "engineering_floor") {
            cur = {
              ...cur,
              floorDelta: cheap.floorDelta,
              floorChecks: cheap.floorChecks,
              floorMustFixNote: cheap.floorMustFixNote ?? cur.floorMustFixNote,
            };
            const cheapKey = computeFailureKey(cheapIdentity);
            // D12 — the round keeps its timeout reason (`fixerSuccess: false`,
            // `fixerSummary` still the timeout message) AND gains the
            // re-check's outcome (`failureKeyAfter`, `passKind: "cheap"`), so
            // a reader can see "timed out, but the failure changed/did not
            // change" instead of a bare failed round.
            rounds.push({
              round,
              failureKeyBefore: keyBefore,
              fixerRan: true,
              fixerSuccess: false,
              fixerSummary,
              verifyVerdictAfter: cur.verifyVerdict,
              failureKeyAfter: cheapKey,
              passKind: "cheap",
              roundElapsedMs: now() - roundClockStart,
            });
            yield {
              type: "content",
              content: `\n> [verify-fix] Round ${round}: cheap re-check after the timeout — the deterministic floor still fails; skipping the verify sub-agent turn this round.\n`,
            };

            if (cheapKey === previousKey) {
              yield {
                type: "content",
                content: `\n> [verify-fix] Round ${round}: no progress after the timeout — the same failure persists; stopping.\n`,
              };
              stopReason = "no_progress";
              break;
            }
            previousKey = cheapKey;

            if (round === limit) {
              yield { type: "content", content: `\n> [verify-fix] Round ${round}: round cap reached; stopping.\n` };
              stopReason = "round_cap";
            }
            continue;
          }
          // The floor no longer fails deterministically even though the fixer
          // itself reported a timeout — inconclusive from the cheap path
          // alone (only a full pass can confirm coverage/structure/the whole
          // picture, and this round already spent its fixer budget on the
          // timeout), so fall through to the ordinary timeout-stop below
          // rather than fabricating a pass.
        }
        // `cheap === undefined` or `!cheap.ranOk` — inconclusive; fall through
        // to the ordinary timeout-stop below rather than guessing.
      }

      yield {
        type: "content",
        content: `\n> [verify-fix] Round ${round}: fix task failed: ${fixResult.error ?? "unknown"}; stopping.\n`,
      };
      rounds.push({
        round,
        failureKeyBefore: keyBefore,
        fixerRan: true,
        fixerSuccess: false,
        fixerSummary,
        verifyVerdictAfter: cur.verifyVerdict,
        failureKeyAfter: keyBefore,
        passKind: "full",
        roundElapsedMs: now() - roundClockStart,
      });
      stopReason = "error";
      break;
    }

    // D2 — a cheap deterministic re-check, run BEFORE paying for a full
    // verify pass, but only when this round's failure is one the floor alone
    // can speak to (see `isCheapRecheckEligible`). `runFloorRecheck` reuses
    // the SAME floor invocation `runVerifyPass` calls internally — see
    // `runDeterministicFloorOnly` in `sprint-runner.ts` — so this never forks
    // the floor logic; it only decides whether to also pay for a sub-agent
    // turn this round.
    const runFloorRecheck = args.runFloorRecheck;
    const cheapRecheckEligible =
      isCheapRecheckEnabled() && runFloorRecheck !== undefined && isCheapRecheckEligible(identityBefore);
    if (cheapRecheckEligible && runFloorRecheck !== undefined) {
      let cheap: FloorRecheckOutcome | undefined;
      try {
        cheap = await runFloorRecheck(`fix-r${round}-recheck`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[verify-fix-loop] cheap floor re-check threw (sprint ${args.sprintN}, round ${round}): ${message}`,
          { stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined },
        );
        cheap = undefined;
      }

      if (cheap?.ranOk) {
        const cheapIdentity = deriveFailureIdentity({
          verifyVerdict: cur.verifyVerdict,
          floorDelta: cheap.floorDelta,
          floorChecks: cheap.floorChecks,
          recipe: cur.recipeFromVerify,
          verifyOutput: verifyOutputOf(cur.verifyResult),
          structureCheck: cur.structureCheck,
        });
        if (cheapIdentity.failedCondition === "engineering_floor") {
          // Still failing the exact same deterministic way (or a different
          // one) — fold the fresh floor evidence into `cur` so the NEXT
          // round's prompt and identity are grounded in what actually just
          // ran, without fabricating a verify sub-agent verdict this round
          // never asked for.
          cur = {
            ...cur,
            floorDelta: cheap.floorDelta,
            floorChecks: cheap.floorChecks,
            // Folded with the checks, never separately: a record that describes a
            // different pass than `floorChecks` came from is worse than none.
            floorDetail: cheap.floorDetail ?? cur.floorDetail,
            floorMustFixNote: cheap.floorMustFixNote ?? cur.floorMustFixNote,
          };
          const cheapKey = computeFailureKey(cheapIdentity);
          rounds.push({
            round,
            failureKeyBefore: keyBefore,
            fixerRan: true,
            fixerSuccess: true,
            fixerSummary: bound(fixResult.output?.trim() || "applied", MAX_SUMMARY_CHARS),
            verifyVerdictAfter: cur.verifyVerdict,
            failureKeyAfter: cheapKey,
            passKind: "cheap",
            roundElapsedMs: now() - roundClockStart,
          });
          yield {
            type: "content",
            content: `\n> [verify-fix] Round ${round}: cheap re-check — the deterministic floor still fails; skipping the verify sub-agent turn this round.\n`,
          };

          if (cheapKey === previousKey) {
            yield {
              type: "content",
              content: `\n> [verify-fix] Round ${round}: no progress — the same failure persists; stopping.\n`,
            };
            stopReason = "no_progress";
            break;
          }
          previousKey = cheapKey;

          if (round === limit) {
            yield { type: "content", content: `\n> [verify-fix] Round ${round}: round cap reached; stopping.\n` };
            stopReason = "round_cap";
          }
          continue;
        }
        // The floor now passes — fall through to the full pass below so the
        // sub-agent gets to confirm the whole picture (coverage, structure,
        // its own opinion), exactly as before D2.
      }
      // `cheap === undefined` or `!cheap.ranOk` — inconclusive; fall through
      // to the full pass rather than guessing from stale evidence.
    }

    let next: VerifyPassOutcome;
    try {
      next = yield* args.runVerifyPass(`fix-r${round}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[verify-fix-loop] re-verify threw (sprint ${args.sprintN}, round ${round}): ${message}`, {
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
      rounds.push({
        round,
        failureKeyBefore: keyBefore,
        fixerRan: true,
        fixerSuccess: true,
        fixerSummary: bound(fixResult.output?.trim() || "applied", MAX_SUMMARY_CHARS),
        verifyVerdictAfter: cur.verifyVerdict,
        failureKeyAfter: keyBefore,
        passKind: "full",
        roundElapsedMs: now() - roundClockStart,
      });
      stopReason = "error";
      break;
    }
    cur = next;

    const identityAfter = deriveFailureIdentity({
      verifyVerdict: cur.verifyVerdict,
      floorDelta: cur.floorDelta,
      floorChecks: cur.floorChecks,
      recipe: cur.recipeFromVerify,
      verifyOutput: verifyOutputOf(cur.verifyResult),
      structureCheck: cur.structureCheck,
    });
    const keyAfter = computeFailureKey(identityAfter);
    // A `verify_verdict` identity with an empty errorSet produces the SAME key
    // every round regardless of whether the underlying problem changed (plain
    // narration carries no recognizable error code or test name) — a repeat of
    // it is UNDECIDABLE, not proof of no progress. Recorded on the round so the
    // artifact shows why the no-progress stop did not fire here.
    const undecidable = isFailureKeyUndecidable(identityAfter);
    rounds.push({
      round,
      failureKeyBefore: keyBefore,
      fixerRan: true,
      fixerSuccess: true,
      fixerSummary: bound(fixResult.output?.trim() || "applied", MAX_SUMMARY_CHARS),
      verifyVerdictAfter: cur.verifyVerdict,
      failureKeyAfter: keyAfter,
      ...(undecidable ? { noProgressUndecidable: true } : {}),
      passKind: "full",
      roundElapsedMs: now() - roundClockStart,
    });

    const stillTriggered = computeVerifyFixTrigger({
      verifyVerdict: cur.verifyVerdict,
      floorDelta: cur.floorDelta,
      floorChecks: cur.floorChecks,
      recipe: cur.recipeFromVerify,
      verifyOutput: verifyOutputOf(cur.verifyResult),
      structureCheck: cur.structureCheck,
    });
    if (!stillTriggered.shouldRun) {
      yield { type: "content", content: `\n> [verify-fix] Round ${round}: re-verify passed.\n` };
      stopReason = "pass";
      break;
    }

    if (!undecidable && keyAfter === previousKey) {
      yield {
        type: "content",
        content: `\n> [verify-fix] Round ${round}: no progress — the same failure persists; stopping.\n`,
      };
      stopReason = "no_progress";
      break;
    }
    previousKey = keyAfter;

    if (round === limit) {
      yield { type: "content", content: `\n> [verify-fix] Round ${round}: round cap reached; stopping.\n` };
      stopReason = "round_cap";
    }
  }

  return { enabled: true, triggered: true, rounds, stopReason, final: cur };
}
