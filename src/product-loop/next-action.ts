/**
 * What would actually change the outcome — the one derivation behind every
 * surface that tells a human (or `/ideal resume`) what to do after a sprint
 * failed its Definition-of-Done gate.
 *
 * ## The defect this replaces
 *
 * `sprint-runner.ts` wrote the resume digest's `Next action` as
 *
 *     `Retry sprint ${sprintN}: ${describeVerdictFailure(verdict)}`
 *
 * for EVERY non-pass verdict. Run `muc2joffe506` on qa-platform ended with
 * `state.md` saying, verbatim:
 *
 *     - Next action: Retry sprint 2: engineering_floor: no_test_commands
 *     - Score: 0.00
 *     - Verify: ERROR
 *
 * (`.muonroi-flow/runs/muc2joffe506/state.md`, alongside
 * `sprints/2-outcome.json`: `"failedCondition": "engineering_floor",
 * "reason": "no_test_commands"`.) Both sprints failed that way and the run cost
 * $1.405.
 *
 * The problem is NOT that a retry was futile — `no_test_commands` is fixable by
 * further work, and the floor re-derives its commands from disk on every pass,
 * so a sprint that declared the runner WOULD change the next verdict. The
 * problem is that **"Retry sprint N" names no action**: it restates the failure
 * and tells the reader to do the same thing again. On that repo the real action
 * was "declare pytest in `backend/requirements.txt`" — `backend/conftest.py`
 * opens with "Pytest configuration for backend tests." while
 * `backend/requirements.txt` never mentions pytest, so the tests existed and
 * nothing declared how to run them.
 *
 * ## What this module does instead
 *
 * Each failure gets a message derived from what it MEANS and from where the fix
 * has to happen, and {@link FixLocus} names that place. `gate-could-not-run`
 * already knows the precise missing thing (`detectGateCouldNotRun` in
 * verify-result.ts records the line that proved it) — that evidence is quoted
 * rather than thrown away.
 *
 * `sprintCanCarryIt` is the locus restated for the caller that has to decide
 * whether the NEXT sprint can act on the message at all: a sprint writes code
 * and closes criteria; it does not edit the user's manifest, install into the
 * user's environment, or answer for the user. It is deliberately not a
 * "retryable / not retryable" split — a `manifest` failure is entirely fixable,
 * just not by the sprint loop on its own.
 */

import type { FloorCheckLike, FloorDelta } from "./verify-baseline.js";
import { detectGateCouldNotRun, type VerifyVerdict } from "./verify-result.js";

/**
 * Where the change that would alter the verdict has to be made.
 *
 * - `code` — the project's source or tests. A sprint can do this.
 * - `criteria` — the run's own success criteria / their evidence. A sprint can
 *   do this.
 * - `manifest` — a declaration in the project's own manifest (a test script, a
 *   test dependency). Outside what a sprint should be rewriting for the user.
 * - `environment` — something must be installed or put on PATH. Nothing ran, so
 *   no code change can produce evidence.
 * - `recipe` — how this project is verified could not be derived at all.
 * - `human` — a person has to decide or validate something.
 * - `none` — the gate passed.
 */
export type FixLocus = "code" | "criteria" | "manifest" | "environment" | "recipe" | "human" | "none";

/** Loci a sprint can act on by itself. Everything else needs someone outside the loop. */
const SPRINT_OWNED: ReadonlySet<FixLocus> = new Set<FixLocus>(["code", "criteria"]);

/**
 * A test tree measured on disk, and the manifest that would declare its runner.
 *
 * Built from `findPytestTargets` (src/verify/pytest-detect.ts) at the call site
 * rather than probed here, so this module stays a pure function of measured
 * facts and the message can name a real path.
 */
export interface TestRunnerEvidence {
  /** Directory holding the marker, relative to the repo root ("" = the root). */
  dir: string;
  /** The file that proved a test tree is there, e.g. `conftest.py`. */
  marker: string;
  /** Manifest that would declare the runner, relative to `dir`, e.g. `requirements.txt`. */
  manifest: string;
  /** The runner's package name, e.g. `pytest`. */
  runner: string;
  /** True when the runner is already declared there (or installed in a venv there). */
  declared: boolean;
}

export interface NextActionInput {
  sprintN: number;
  /**
   * The done-gate's verdict. Typed loosely (`string` rather than the
   * `DoneCondition` union) for the same reason `describeVerdictFailure` is: a
   * `SprintOutcome` read back off disk carries plain strings.
   */
  verdict: {
    pass: boolean;
    score?: number;
    failedCondition?: string | null;
    reason?: string | null;
  };
  /** The adjudicated verify verdict, when the caller has one. */
  verifyVerdict?: VerifyVerdict;
  /** The deterministic floor's own delta, when a floor ran. */
  floorDelta?: FloorDelta;
  /** The floor's per-command evidence, when a floor ran. */
  floorChecks?: FloorCheckLike[];
  /**
   * The verify sub-agent's own narration, when the caller has it.
   *
   * Read for exactly one purpose: when the floor PASSED and the sub-agent still
   * reported failure, the failing thing is outside the floor's command set, and
   * the only record of what it was is that narration. `detectGateCouldNotRun`
   * (verify-result.ts) is run over it so an un-runnable gate the sub-agent hit —
   * a missing launcher, module or script — is named as the ENVIRONMENT fact it is
   * rather than blamed on the code. Never used to decide pass/fail.
   */
  verifyOutput?: string;
  /** Test trees measured on disk — see {@link TestRunnerEvidence}. */
  testRunnerEvidence?: readonly TestRunnerEvidence[];
  /**
   * Where a `zero_coverage` reason's zero came from. The done-gate reports that
   * reason ONLY for a zero the verify floor measured (`isVerifiedZeroCoverage`,
   * done-gate.ts:43-45), which is why `"measured"` is the default. CB-3 reports
   * the same word for a zero the verify sub-agent merely CLAIMED
   * (`isClaimedZeroCoverage`, circuit-breakers.ts), and a message must not call
   * a claim a measurement.
   */
  coverageZeroProvenance?: "measured" | "claimed";
}

export interface NextActionAdvice {
  /**
   * One line naming what would change the outcome. Single-line and free of
   * leading `- ` so it survives `renderResumeDigest` → `parseResumeDigest`
   * (src/flow/run-artifacts.ts).
   */
  action: string;
  locus: FixLocus;
  /** Whether the next sprint could carry `action` out by itself. */
  sprintCanCarryIt: boolean;
}

/** Longest evidence excerpt quoted into a one-line digest field. */
const MAX_EVIDENCE_CHARS = 200;
/** Longest command echoed into a one-line digest field. */
const MAX_COMMAND_CHARS = 120;
/** How many failing test identities the message spells out before counting. */
const MAX_NAMED_TESTS = 3;

function oneLine(s: string, cap: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function advise(action: string, locus: FixLocus): NextActionAdvice {
  return { action: oneLine(action, 600), locus, sprintCanCarryIt: SPRINT_OWNED.has(locus) };
}

/** The verify report for this sprint, which every "go read it" message points at. */
function verifyReportPath(sprintN: number): string {
  return `sprints/${sprintN}-verify.md`;
}

/**
 * The `couldNotRun` signal the floor recorded, preferring the command the delta
 * blamed and falling back to any failed check that carries one (the delta names
 * `failedCommand` only when the comparison rule produced one).
 */
function couldNotRunCheck(input: NextActionInput): FloorCheckLike | undefined {
  const checks = input.floorChecks ?? [];
  const blamed = input.floorDelta?.failedCommand;
  return checks.find((c) => c.couldNotRun && c.command === blamed) ?? checks.find((c) => c.couldNotRun);
}

function describeCouldNotRun(input: NextActionInput, sprintN: number): NextActionAdvice {
  const check = couldNotRunCheck(input);
  const command = oneLine(check?.command ?? input.floorDelta?.failedCommand ?? "", MAX_COMMAND_CHARS);
  const where = command ? ` \`${command}\` never ran` : " the gate never ran";
  const evidence = check?.couldNotRun ? ` — ${oneLine(check.couldNotRun.evidence, MAX_EVIDENCE_CHARS)}` : "";

  switch (check?.couldNotRun?.kind) {
    case "dependency_missing":
      return advise(
        `Install the module the gate needs for the interpreter it uses, and declare it in that project's manifest:${where}${evidence}. Until it is installed nothing executes, so re-running sprint ${sprintN} produces no evidence either.`,
        "environment",
      );
    case "launcher_missing":
      return advise(
        `Make the gate's launcher runnable — install it, or correct the path the recipe invokes:${where}${evidence}. The launcher is missing, not the code, so re-running sprint ${sprintN} changes nothing.`,
        "environment",
      );
    case "script_missing":
      return advise(
        `Add the missing script to the project's own manifest (or correct the command the recipe invokes):${where}${evidence}.`,
        "manifest",
      );
    default:
      // `gate-could-not-run` was the delta's kind but no per-command signal
      // survived — say exactly that rather than inventing a sub-kind.
      return advise(
        `A gate command could not RUN — its launcher, module or script is missing, so it never reached the code:${where}${evidence}. Read ${verifyReportPath(sprintN)} for the line that proved it; this is an environment fix, not a code one.`,
        "environment",
      );
  }
}

/** The floor's own failure kind, when a floor ran and failed, translated into an action. */
function describeFloorFailure(input: NextActionInput, sprintN: number): NextActionAdvice | null {
  const delta = input.floorDelta;
  if (!delta || delta.verdict !== "fail") return null;

  switch (delta.failureKind) {
    case "gate-could-not-run":
      return describeCouldNotRun(input, sprintN);

    case "build-failed": {
      const command = delta.failedCommand ? ` (\`${oneLine(delta.failedCommand, MAX_COMMAND_CHARS)}\`)` : "";
      const inherited =
        delta.buildAlreadyBroken && delta.buildAttribution === "pre-existing"
          ? " It was already failing at baseline, so it is not this run's doing — but nothing can be verified on a red build."
          : "";
      return advise(
        `Fix the build/typecheck break${command} — no test result is attributable while it is red.${inherited} Then re-run sprint ${sprintN}.`,
        "code",
      );
    }

    case "test-regression": {
      const named = delta.newlyFailing.slice(0, MAX_NAMED_TESTS).join(", ");
      const more =
        delta.newlyFailing.length > MAX_NAMED_TESTS ? ` +${delta.newlyFailing.length - MAX_NAMED_TESTS} more` : "";
      return advise(
        `Fix the ${delta.newlyFailing.length} test(s) this sprint broke — ${named}${more} — then re-run sprint ${sprintN}.`,
        "code",
      );
    }

    case "no-tests-executed": {
      const signal = input.floorChecks?.find((c) => c.noTests)?.noTests;
      const evidence = signal ? ` — ${oneLine(signal.evidence, MAX_EVIDENCE_CHARS)}` : "";
      const loadError = signal?.kind === "load_error";
      return loadError
        ? advise(
            `Fix the test file that will not load${evidence} — the suite is broken, so it selected and executed nothing. Then re-run sprint ${sprintN}.`,
            "code",
          )
        : advise(
            `Make the suite select the tests it is meant to run${evidence} — zero executed tests is zero evidence. Then re-run sprint ${sprintN}.`,
            "code",
          );
    }

    case "test-unattributable":
    case "test-absolute-no-baseline": {
      const named = delta.newlyFailing.slice(0, MAX_NAMED_TESTS).join(", ");
      const list = named ? ` (${named})` : "";
      return advise(
        `Fix what the test gate reported${list} — read ${verifyReportPath(sprintN)} for its output, since it named no attributable failure. Then re-run sprint ${sprintN}.`,
        "code",
      );
    }

    case "infra":
      return advise(
        `A gate command could not be run to completion (spawn error or timeout), so it produced no evidence — read ${verifyReportPath(sprintN)} and fix the harness before re-running sprint ${sprintN}.`,
        "environment",
      );

    default:
      return null;
  }
}

/**
 * `no_test_commands` — the recipe exists and named no test command.
 *
 * With a measured test tree whose runner is undeclared, the message names the
 * exact manifest to add it to; without one it names the class of change, never
 * "retry".
 */
function describeNoTestCommands(input: NextActionInput, sprintN: number): NextActionAdvice {
  const undeclared = input.testRunnerEvidence?.find((t) => !t.declared);
  if (undeclared) {
    const manifestPath = undeclared.dir ? `${undeclared.dir}/${undeclared.manifest}` : undeclared.manifest;
    const markerPath = undeclared.dir ? `${undeclared.dir}/${undeclared.marker}` : undeclared.marker;
    return advise(
      `Declare ${undeclared.runner} in \`${manifestPath}\` (or add a test command the recipe can discover) — \`${markerPath}\` shows the tests are there, and nothing declares how to run them, so the floor found no test command to execute.`,
      "manifest",
    );
  }
  return advise(
    `Add a test command this project's own manifest declares — a test script, or a test dependency plus a tests tree the runner can find. The floor re-derives its commands from disk every pass, so sprint ${sprintN} keeps failing until one exists.`,
    "manifest",
  );
}

/**
 * The floor MEASURED the project's own gates green and the verify sub-agent still
 * reported failure — so whatever failed is outside what the floor executes.
 *
 * ## Why this needs its own message
 *
 * Until the floor ran on a model-reported FAIL this combination did not exist:
 * `sprint-runner.ts` gated the floor on `PASS || UNKNOWN`, so a `VERIFY_FAIL`
 * narration produced no measurement at all and the only thing anyone could be
 * told was `reason: "verify_FAIL"` → "read the report". Measured, run
 * `muc2joffe506` sprint 1: the narration reported "Build ✓, Tests 12/12 ✓, Lint 0
 * errors ✓" and failed at Phase 3 because the host's Docker daemon was down (the
 * `docker-desktop` WSL distro was Stopped). Both halves of that are actionable and
 * neither survived: `sprints/1-outcome.json` says only
 * `{"failedCondition":"engineering_floor","reason":"verify_FAIL","criteriaUnmet":4}`.
 *
 * ## The locus, and why it is not `code`
 *
 * The floor cannot say what the sub-agent failed on, only that its own commands
 * are green — so nothing here identifies a code change, and calling the locus
 * `code` would assert one. Two facts are in evidence and they disagree: a
 * measurement says the build and tests pass, a narration says the sprint failed.
 * Adjudicating that is exactly what `applyVerifyFloor` refuses to do, and this
 * module must not do it either by implying the sprint can fix it by writing code.
 * `human` is the honest locus — someone has to read which phase failed and decide
 * whether it is a real defect or an environment gap — EXCEPT when the narration
 * itself carries a measured un-runnable-gate line, which names the environment.
 *
 * Returns null when the floor did not pass, or when the verdict is not a positive
 * failure claim (nothing to reconcile).
 */
function describeFloorGreenModelRed(input: NextActionInput, sprintN: number): NextActionAdvice | null {
  if (input.floorDelta?.verdict !== "pass") return null;
  if (input.verifyVerdict !== "FAIL" && input.verifyVerdict !== "ERROR") return null;

  const ran = (input.floorChecks ?? []).filter((c) => c.ok).length;
  const measured = ran > 0 ? `${ran} deterministic gate(s) PASSED (build/typecheck + tests, measured)` : "";

  // The same detector the floor runs over its OWN command output, here over the
  // sub-agent's narration — one vocabulary for "it could not run", not a second.
  const couldNotRun = input.verifyOutput ? detectGateCouldNotRun(input.verifyOutput) : null;
  if (couldNotRun) {
    return advise(
      `Fix the ENVIRONMENT the verify stage could not get past — ${oneLine(couldNotRun.evidence, MAX_EVIDENCE_CHARS)}. ${
        measured ? `${measured}, so the code-level gates are green` : "The floor's own gates passed"
      } and no code change makes that step run. Read ${verifyReportPath(sprintN)} for the phase it stopped in.`,
      "environment",
    );
  }

  return advise(
    `${measured || "The floor's own gates passed"}, and the verify stage still reported ${input.verifyVerdict} on a phase the floor does not execute — read ${verifyReportPath(sprintN)} to see which one, and decide whether it is a defect or an environment gap. Re-running sprint ${sprintN} runs the same un-measured phase again, and the floor's measurement does not lift the verify stage's own failure.`,
    "human",
  );
}

/** `verify_FAIL` with no floor evidence to go on. */
function describeVerifyVerdictOnly(input: NextActionInput, sprintN: number): NextActionAdvice {
  if (input.verifyVerdict === "ERROR") {
    return advise(
      `The verify stage did not report a verdict (ERROR) — read ${verifyReportPath(sprintN)} for what it last did and fix what stopped it. Re-running sprint ${sprintN} runs the same stage again.`,
      "environment",
    );
  }
  if (input.verifyVerdict === "UNKNOWN") {
    return advise(
      `Nothing adjudicated this sprint: the verify stage emitted no verdict and the deterministic floor found no command to run. Give the project a discoverable build or test command, then re-run sprint ${sprintN}.`,
      "manifest",
    );
  }
  return advise(
    `Fix what the verify stage reported failing — read ${verifyReportPath(sprintN)} for its output — then re-run sprint ${sprintN}.`,
    "code",
  );
}

function describeEngineeringFloor(input: NextActionInput, sprintN: number): NextActionAdvice {
  const reason = input.verdict.reason?.trim() || "";

  if (reason === "no_recipe") {
    return advise(
      `No verification recipe could be derived from this working tree, so nothing was verifiable. Point \`/ideal\` at the sub-project that holds the tests, or declare a build/test command in the project's manifest — a retry re-derives the recipe from the same tree.`,
      "recipe",
    );
  }
  if (reason === "no_test_commands") return describeNoTestCommands(input, sprintN);
  if (reason === "zero_coverage") {
    return input.coverageZeroProvenance === "claimed"
      ? advise(
          `Add tests that execute this project's code — the verify recipe REPORTED zero coverage (a figure the verify agent wrote, not one the floor measured). If the project really is tested, correct the recipe instead. Then re-run sprint ${sprintN}.`,
          "code",
        )
      : advise(
          `Add tests that execute the code this sprint changed — coverage was MEASURED at 0, so the suite ran and covered nothing. Then re-run sprint ${sprintN}.`,
          "code",
        );
  }

  // `verify_FAIL` (and any future reason): the floor's own evidence is the most
  // specific thing anyone has, so it is preferred over the gate's coarse label.
  // A floor that PASSED is evidence too — it rules the code-level gates out — so
  // it is read before falling back to the verdict on its own.
  return (
    describeFloorFailure(input, sprintN) ??
    describeFloorGreenModelRed(input, sprintN) ??
    describeVerifyVerdictOnly(input, sprintN)
  );
}

/**
 * Derive the one line every surface shows after a sprint's done-gate verdict.
 *
 * Deterministic for a fixed input, and never throws — this feeds `state.md`,
 * the transcript and the next sprint's carry-over focus, none of which may fail
 * because a message could not be phrased.
 */
export function deriveNextAction(input: NextActionInput): NextActionAdvice {
  const { sprintN, verdict } = input;

  if (verdict.pass) {
    return {
      action: "Definition-of-Done met — advance to the next phase or ship",
      locus: "none",
      sprintCanCarryIt: false,
    };
  }

  const condition = verdict.failedCondition?.trim() || "";
  const reason = verdict.reason?.trim() || "";

  switch (condition) {
    case "engineering_floor":
      return describeEngineeringFloor(input, sprintN);

    case "evidence_regex":
      return advise(
        `Attach real evidence to the criteria that claim to be met — ${reason || "evidence is missing"} — a file:line or command output the reality anchor accepts. Then re-run sprint ${sprintN}.`,
        "criteria",
      );

    case "weighted_score":
      return advise(
        `Close the remaining success criteria — ${reason || "the score is below the done threshold"} — then re-run sprint ${sprintN} on the unmet ones.`,
        "criteria",
      );

    case "assumption_ledger":
      return advise(
        `Validate or drop the blocking assumptions before ship: ${reason || "unverified critical assumptions"}. A sprint cannot clear them for you.`,
        "human",
      );

    case "customer_debate":
      return advise(
        `Address the customer's objection — ${reason || "no reason recorded"} — then re-run sprint ${sprintN}.`,
        "criteria",
      );

    case "user_approval":
      return advise(
        `Act on the rejection at the final approval gate: ${reason || "no feedback recorded"}. Nothing advances until it is answered.`,
        "human",
      );

    default: {
      // No condition at all, or one this module has not been taught. Name both
      // halves rather than falling back to "retry" — the whole defect.
      const named = condition && reason && reason !== condition ? `${condition}: ${reason}` : condition || reason;
      return advise(
        named
          ? `Sprint ${sprintN} failed ${named} — read ${verifyReportPath(sprintN)} and the sprint outcome for what that condition measured before deciding what to change.`
          : `Sprint ${sprintN} did not meet Definition-of-Done and recorded no condition — read ${verifyReportPath(sprintN)} and the sprint outcome before deciding what to change.`,
        "code",
      );
    }
  }
}
