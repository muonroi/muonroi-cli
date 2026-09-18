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
 */

import type { StreamChunk, TaskRequest, ToolResult, VerifyRecipe } from "../types/index.js";
import { runIsolatedGuarded } from "./plan-adherence-review.js";
import { hasProjectRegistrationViolations, type ProjectRegistrationCheckResult } from "./project-registration-check.js";
import { boundTaskText } from "./sprint-plan-artifact.js";
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

  const hasTests = (recipe?.testCommands?.length ?? 0) > 0;
  const hasCoverage = (recipe?.coverage ?? 0) > 0;
  if (hasTests && !hasCoverage) {
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

  if (floorDelta?.verdict === "fail" && floorDelta.failureKind === "build-failed") {
    if (floorDelta.buildAlreadyBroken === true && floorDelta.buildAttribution === "pre-existing") {
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
      default:
        // "infra" (spawn error / timeout) — no evidence a code fixer can act on.
        break;
    }
  }

  const hasTests = (recipe?.testCommands?.length ?? 0) > 0;
  const hasCoverage = (recipe?.coverage ?? 0) > 0;
  if (hasTests && !hasCoverage) {
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
 * The fixer's prompt. New text — no existing prompt in the codebase is
 * reworded to build this. Bounded: a verify tail, the floor's must-fix note
 * (carries the attribution sentence from `describeBuildMustFix`), the failure's
 * own error set, the sprint's still-open tasks, and the approved plan.
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
      });
      stopReason = reason;
      break;
    }

    if (!fixResult.success) {
      yield {
        type: "content",
        content: `\n> [verify-fix] Round ${round}: fix task failed: ${fixResult.error ?? "unknown"}; stopping.\n`,
      };
      rounds.push({
        round,
        failureKeyBefore: keyBefore,
        fixerRan: true,
        fixerSuccess: false,
        fixerSummary: bound(fixResult.error ?? "fix failed", MAX_SUMMARY_CHARS),
        verifyVerdictAfter: cur.verifyVerdict,
        failureKeyAfter: keyBefore,
      });
      stopReason = "error";
      break;
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
