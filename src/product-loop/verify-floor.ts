/**
 * src/product-loop/verify-floor.ts
 *
 * The DETERMINISTIC verify floor for the /ideal sprint loop.
 *
 * ## Why this exists
 *
 * Before this module, a sprint's verify verdict came entirely from an LLM
 * sub-agent narrating its own run: `sprint-runner.ts` calls
 * `runVerifyOrchestration` (`src/verify/orchestrator.ts:129`), which builds a
 * prompt and runs `agent.runTaskRequest({ agent: "verify", ... })`. The verdict
 * is then `parseVerifyResult`, which PASSES as soon as the model's narration
 * contains the literal string `VERIFY_PASS`. No command's exit code was ever
 * consulted. A sprint could therefore commit code that does not compile, add a
 * test file whose imports do not resolve, and still be scored PASS.
 *
 * This floor runs the project's OWN gates and treats their exit codes as
 * authoritative. The LLM's opinion is only allowed to confirm a PASS the
 * commands already earned; it can never manufacture one.
 *
 * ## Anti-gaming: commands come from disk, not from the model
 *
 * The commands are re-derived from the working tree via
 * `inferVerifyProjectProfile(cwd)` (`src/verify/recipes.ts:558`) — the same
 * package.json / pyproject / go.mod / Cargo.toml / *.sln / Makefile probing the
 * verify recipe already uses. They are deliberately NOT taken from the
 * `VerifyRecipe` the verify sub-agent returned: that recipe is model-influenced,
 * so a model that emitted `testCommands: []` would silently disarm its own gate.
 * Disk-derived commands are unspoofable from inside the turn.
 *
 * Nothing here is hardcoded per-project: this module never names `tsc`,
 * `vitest`, `pytest` or any script. It executes whatever the project declares.
 *
 * ## What is deliberately NOT run
 *
 * `installCommands` / `bootstrapCommands` / `shellInitCommands` are environment
 * setup, not gates. Running them would mutate `node_modules` (or the host) as a
 * side effect of scoring a sprint, so the floor executes only the recipe's
 * build/typecheck and test commands.
 *
 * ## What it gates AGAINST: the delta, not zero
 *
 * The floor used to require ZERO failing tests. That is only satisfiable in a
 * repository whose suite is already green, so in any real project with
 * pre-existing failures the gate could never open — see the measured evidence in
 * `verify-baseline.ts`. It now compares the run's result against a baseline
 * captured before the loop started changing things, and fails only on a
 * REGRESSION. With no usable baseline it falls back to the absolute comparison
 * (fail-closed) and says so; the defence of that direction is in
 * `verify-baseline.ts`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import type { VerifyRecipe } from "../types/index.js";
import { createGitSpawnBudget, type GitSpawnBudget, runGitSpawn } from "../utils/git-spawn.js";
import { isIdealRunUnlimited } from "../utils/ideal-run-scope.js";
import { logger } from "../utils/logger.js";
import { extractCoverageFromOutput } from "../verify/coverage-parsers.js";
import { inferVerifyProjectProfile } from "../verify/recipes.js";
import { parseFailingTestIds, type TestRunnerFormat } from "./test-failure-parse.js";
import {
  boundDirtyFiles,
  buildFailureSignature,
  computeFloorDelta,
  describeBaselineRule,
  extractErrorSet,
  type FloorDelta,
  isToleratedTestFailure,
  loadFloorBaseline,
  resolveBaselinePathFromEnv,
  sha256Hex,
  VERIFY_BASELINE_VERSION,
  type VerifyBaseline,
  type VerifyBaselineCommandResult,
  verifyBaselinePath,
  writeVerifyBaseline,
} from "./verify-baseline.js";
import {
  detectGateCouldNotRun,
  detectNoTestsExecuted,
  type GateCouldNotRunSignal,
  type NoTestsSignal,
  type VerifyVerdict,
} from "./verify-result.js";

/** Per-command wall-clock budget. Mirrors the verify watchdog's 10-minute default. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap captured output so a chatty runner cannot blow up the sprint feedback. */
const OUTPUT_TAIL_CHARS = 4000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type FloorVerdict = "pass" | "fail" | "unavailable";

/**
 * One progress beat from the floor, emitted before and after every gate command.
 *
 * The floor shells out to the project's OWN build and test commands, which on a
 * real repository is minutes of work, not milliseconds. Measured on run
 * `mttwpmu8ee5b`: `captureVerifyFloorBaseline` took 53,133ms and the process-level
 * freeze detector logged `event loop blocked for 53029ms` in the same second —
 * the two numbers are 100ms apart, because the runner used `spawnSync`. The whole
 * TUI was dead for the duration, with nothing on screen to say why.
 *
 * `runFloorCommand` is now `spawn`-based and awaited, so the loop stays free; this
 * callback is what the caller turns into something for the user to look at while
 * it runs. It carries no formatting decisions — the caller owns presentation.
 */
export interface FloorProgress {
  phase: "start" | "done";
  kind: "build" | "test";
  command: string;
  /** 0-based position of this command in the whole planned set. */
  index: number;
  total: number;
  /** Only on `phase: "done"`. */
  ok?: boolean;
  exitCode?: number | null;
  elapsedMs?: number;
}

/** Why the floor produced no evidence. Only ever set when verdict === "unavailable". */
export type FloorUnavailableReason = "disabled" | "no-commands-discovered";

export interface FloorCheck {
  /** Which tier of the recipe this command came from. */
  kind: "build" | "test";
  command: string;
  /** Process exit code; null when the process never produced one (spawn error / signal). */
  exitCode: number | null;
  /** True only when the command ran to completion with exit 0 AND produced evidence. */
  ok: boolean;
  timedOut: boolean;
  /** Populated when the command could not be spawned at all. */
  spawnError?: string;
  /** Tail of combined stdout+stderr, truncated to OUTPUT_TAIL_CHARS. */
  outputTail: string;
  elapsedMs: number;
  /** Set when a test command ran but executed zero tests (see detectNoTestsExecuted). */
  noTests?: NoTestsSignal;
  /**
   * Set when the command never got to run the thing it was meant to run — a
   * missing launcher, module or script (see `detectGateCouldNotRun`). Computed
   * for BOTH tiers: a build gate whose compiler is absent is an un-runnable
   * gate, not a broken build.
   */
  couldNotRun?: GateCouldNotRunSignal;
  /**
   * Failing test identities parsed from this command's FULL output — computed
   * here, before `outputTail` truncates, because a clipped list would make the
   * clipped-away failures look newly-failing on the next run.
   */
  failingTests?: string[];
  /** Which runner grammars produced those identities. Empty when none matched. */
  formats?: TestRunnerFormat[];
  /**
   * Error identities extracted from this command's FULL output (build/typecheck
   * only — see `extractErrorSet`). Always computed for a build command, even
   * when empty; used to attribute a build failure that was ALSO red at baseline.
   */
  errorSet?: string[];
  /**
   * Test coverage parsed from this command's FULL output (test commands only).
   *
   * `null`/absent means NOT MEASURED — the runner printed no coverage summary,
   * which is the normal case (`dotnet test` without `/p:CollectCoverage=true`
   * prints none at all). It is never 0 for that: downstream, 0 means "measured,
   * and nothing is covered" and blocks the engineering floor. Parsed from the
   * full output for the same reason `failingTests` is — `outputTail` truncates,
   * and a clipped-away summary would read as "not measured".
   */
  coverage?: number | null;
}

export interface VerifyFloorResult {
  verdict: FloorVerdict;
  /** Set only when verdict === "unavailable". */
  unavailableReason?: FloorUnavailableReason;
  checks: FloorCheck[];
  commandsDiscovered: { build: string[]; test: string[] };
  elapsedMs: number;
  /** Human/agent-readable summary, safe to splice into sprint feedback. */
  detail: string;
  /**
   * How the verdict was reached: which comparison rule applied, what newly
   * failed, and what was tolerated. Absent only when verdict === "unavailable".
   */
  delta?: FloorDelta;
  /**
   * Coverage this run actually MEASURED from the project's own test output, or
   * null when nothing measurable was printed.
   *
   * This is the only non-model source of the number: `VerifyRecipe.coverage` is
   * otherwise whatever the verify sub-agent hand-wrote into its recipe JSON
   * (`normalizeVerifyRecipe`, src/verify/recipes.ts). `sprint-runner.ts`
   * overwrites the asserted figure with this one before the done-gate reads it,
   * so a measurement always beats an assertion.
   *
   * When several test commands each report a figure they cover disjoint
   * assemblies/packages and no arithmetic combines them honestly, so this is the
   * MAXIMUM of the non-null ones. That is the principled choice for the only
   * question the gates ask of it: a maximum of 0 means EVERY command that
   * measured measured zero, which is the sole condition under which "nothing is
   * covered" is a truthful claim.
   */
  measuredCoverage: number | null;
}

export interface RunVerifyFloorOpts {
  /** Working tree to discover commands in and execute them from. */
  cwd: string;
  /** Per-command wall-clock budget in ms. Defaults to MUONROI_SPRINT_FLOOR_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
  /**
   * Bypass the `MUONROI_SPRINT_VERIFY_FLOOR` env gate. Tests use this to drive
   * the real code path without mutating process.env. Mirrors the `forceEnable`
   * convention in `sprint-self-verify.ts`.
   */
  forceEnable?: boolean;
  /**
   * Explicit command override, used only by tests that need a deterministic
   * command set. Production always discovers from disk.
   */
  commandsOverride?: { build: string[]; test: string[] };
  /**
   * Where this run's baseline lives. Defaults to `MUONROI_SPRINT_FLOOR_BASELINE`.
   * When neither resolves, the floor applies the ABSOLUTE rule and says so.
   */
  baselinePath?: string | null;
  /** The /ideal run asking. A baseline stamped with a different run id is rejected. */
  runId?: string;
  /** Per-command progress beats, so a caller can keep the UI alive. See FloorProgress. */
  onProgress?: (p: FloorProgress) => void;
}

export interface CaptureBaselineOpts {
  /** Working tree to discover commands in and execute them from. */
  cwd: string;
  /** The /ideal run this baseline belongs to. Stamped into the record. */
  runId: string;
  /** Run directory root — the baseline is written to `<flowDir>/runs/<runId>/verify-baseline.json`. */
  flowDir?: string;
  /** Explicit destination, overriding flowDir. */
  baselinePath?: string;
  timeoutMs?: number;
  commandsOverride?: { build: string[]; test: string[] };
  /** Per-command progress beats, so a caller can keep the UI alive. See FloorProgress. */
  onProgress?: (p: FloorProgress) => void;
}

export interface CaptureBaselineResult {
  baseline: VerifyBaseline;
  path: string;
  elapsedMs: number;
}

function envDisabled(name: string): boolean {
  const v = process.env[name];
  return v === "0" || (typeof v === "string" && v.toLowerCase() === "false");
}

/**
 * Whole-floor gate. Default ON — the floor is the point, so it must not be
 * opt-in. `MUONROI_SPRINT_VERIFY_FLOOR=0` disables it for an emergency bypass.
 */
export function isFloorEnabled(forceEnable?: boolean): boolean {
  if (forceEnable === true) return true;
  return !envDisabled("MUONROI_SPRINT_VERIFY_FLOOR");
}

/**
 * Test-tier gate. Default ON. `MUONROI_SPRINT_FLOOR_TESTS=0` drops the floor to
 * build/typecheck only — much faster, but a resulting PASS then rests on zero
 * executed tests, which `formatFloorDetail` states explicitly so the weaker
 * guarantee is never invisible.
 */
export function areFloorTestsEnabled(): boolean {
  return !envDisabled("MUONROI_SPRINT_FLOOR_TESTS");
}

export function getFloorTimeoutMs(): number {
  const raw = process.env.MUONROI_SPRINT_FLOOR_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * A discovered gate is a STYLE gate when it is the project's `lint` or `check`
 * script. `inferFallbackRecipe` folds `["test", "check", "lint"]` into one
 * `testCommands` array (`src/verify/recipes.ts:263-267`), so the floor
 * re-separates them here.
 *
 * Why they do not block by default: a style violation is not a broken build,
 * lint configurations drift independently of correctness, and a repository whose
 * lint gate is already red at its base commit would fail EVERY sprint for a
 * reason no sprint caused. Measured on this repo at 29b5abfe, `bun run lint`
 * reports 492 errors / 1276 warnings with a clean working tree — a floor that
 * blocked on it could never pass, which is indistinguishable from no floor.
 *
 * Set `MUONROI_SPRINT_FLOOR_STYLE_GATES=1` to make style gates blocking too.
 */
const STYLE_SCRIPT_SUFFIX = /(?:^|\s)(?:lint|check)$/;

export function isStyleGate(command: string): boolean {
  return STYLE_SCRIPT_SUFFIX.test(command.trim());
}

export function areStyleGatesBlocking(): boolean {
  const v = process.env.MUONROI_SPRINT_FLOOR_STYLE_GATES;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/**
 * Discover the floor's commands from the working tree.
 *
 * `buildCommands` is the recipe's build + typecheck tier; `testCommands` is its
 * test/check/lint tier (see `inferFallbackRecipe` in `src/verify/recipes.ts`).
 * Both are whatever the project declares — this function names no tool.
 */
export function resolveFloorCommands(cwd: string): { build: string[]; test: string[] } {
  try {
    const profile = inferVerifyProjectProfile(cwd);
    const recipe: VerifyRecipe = profile.recipe;
    const blockStyle = areStyleGatesBlocking();
    return {
      build: [...(recipe.buildCommands ?? [])].filter((c) => c.trim().length > 0),
      test: [...(recipe.testCommands ?? [])]
        .filter((c) => c.trim().length > 0)
        .filter((c) => blockStyle || !isStyleGate(c)),
    };
  } catch (err) {
    logger.error(
      "orchestrator",
      `[verify-floor] command discovery failed for cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      {
        operation: "resolveFloorCommands",
        cwd,
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return { build: [], test: [] };
  }
}

/**
 * The project's ecosystem, from the same disk probe `resolveFloorCommands` uses
 * — never from the model's recipe, for the same anti-gaming reason.
 *
 * Only ever used to pick a coverage grammar. Returns null when the probe fails,
 * and the floor then measures no coverage rather than guessing a grammar; that
 * is an honest "unmeasured", which blocks nothing.
 */
export function resolveFloorEcosystem(cwd: string): string | null {
  try {
    const ecosystem = inferVerifyProjectProfile(cwd).recipe.ecosystem;
    return typeof ecosystem === "string" && ecosystem.trim() ? ecosystem.trim() : null;
  } catch (err) {
    logger.warn(
      "orchestrator",
      `[verify-floor] ecosystem discovery failed for cwd=${cwd} — coverage will not be measured this run`,
      {
        operation: "resolveFloorEcosystem",
        cwd,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return null;
  }
}

/**
 * Fold the per-command coverage figures into the one number the gates read.
 *
 * Returns null when NOTHING measured — never 0, because 0 means "measured, and
 * nothing is covered" and blocks the engineering floor. See
 * `VerifyFloorResult.measuredCoverage` for why the fold is a maximum.
 */
export function foldMeasuredCoverage(checks: FloorCheck[]): number | null {
  const measured = checks
    .map((c) => c.coverage)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (measured.length === 0) return null;
  return Math.max(...measured);
}

function tail(s: string): string {
  if (s.length <= OUTPUT_TAIL_CHARS) return s;
  return `…(truncated ${s.length - OUTPUT_TAIL_CHARS} chars)…\n${s.slice(-OUTPUT_TAIL_CHARS)}`;
}

/**
 * Execute one gate command and decide whether it produced PASSING EVIDENCE.
 *
 * `ok` is deliberately stricter than `exitCode === 0`: a test command that exits
 * 0 while executing zero tests has produced no evidence, and absence of evidence
 * is not evidence of correctness. That check reuses `detectNoTestsExecuted` from
 * `verify-result.ts` rather than restating its patterns here.
 *
 * WHAT `timeoutMs` MEASURES depends on the run. Normally it is total elapsed:
 * the command is killed once it has run that long, whatever it is doing. Inside
 * an `/ideal` run (user decision: no limits) it bounds SILENCE instead — the
 * timer is re-armed on every stdout/stderr chunk, so a build or test suite that
 * is still printing is never killed for taking too long, while one that has
 * printed nothing for the whole window still is. The liveness signal this needs
 * was already being collected by the `sink` handlers below; it simply took no
 * part in the decision. The number itself is unchanged in both modes, and so is
 * `MUONROI_SPRINT_FLOOR_TIMEOUT_MS`.
 */
export async function runFloorCommand(
  kind: "build" | "test",
  command: string,
  cwd: string,
  timeoutMs: number,
  /**
   * The project's ecosystem, used ONLY to pick a coverage grammar for a test
   * command's output. Optional: omitted, coverage is simply not measured, which
   * is a state the gates handle (see `FloorCheck.coverage`) — it never changes
   * the verdict.
   */
  ecosystem?: string,
): Promise<FloorCheck> {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let spawnError: string | undefined;
  // Read the scope ONCE, synchronously: the child's `data` events fire from
  // listeners whose async context is not guaranteed to carry the run scope.
  const silenceMode = isIdealRunUnlimited();

  await new Promise<void>((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        // The gate must never wait on a prompt; keep stdin closed.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator", `[verify-floor] spawn threw for ${kind} command "${command}" in ${cwd}`, {
        operation: "runFloorCommand",
        cwd,
        command,
        error: spawnError,
      });
      resolveRun();
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun();
    };
    const armTimer = (): void => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch (err) {
          logger.warn("orchestrator", `[verify-floor] could not kill timed-out command "${command}"`, {
            operation: "runFloorCommand",
            cwd,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, timeoutMs);
    };
    armTimer();

    // Bound what we hold in memory, the way spawnSync's maxBuffer did — but
    // WITHOUT killing the run: a chatty-but-green build must not be scored as a
    // failure just because it printed a lot.
    let captured = 0;
    const sink = (which: "out" | "err") => (buf: Buffer | string) => {
      // Proof of life. Re-armed BEFORE the capture cap returns early, so a
      // command that has already filled the buffer is still recognised as alive.
      if (silenceMode && !settled && !timedOut) {
        clearTimeout(timer);
        armTimer();
      }
      if (captured >= MAX_BUFFER_BYTES) return;
      const text = typeof buf === "string" ? buf : buf.toString("utf8");
      captured += text.length;
      if (which === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", sink("out"));
    child.stderr?.on("data", sink("err"));
    child.on("error", (err: Error) => {
      spawnError = err.message;
      finish();
    });
    child.on("close", (code: number | null) => {
      exitCode = code;
      finish();
    });
  });

  const combined = `${stdout}${stderr}`;
  const noTests = kind === "test" ? (detectNoTestsExecuted(combined) ?? undefined) : undefined;
  // Only meaningful for a command that FAILED: a green run's output cannot be
  // telling us the gate never started, and classifying a passing command would
  // be reading tea leaves.
  const failed = Boolean(spawnError) || timedOut || exitCode !== 0;
  const couldNotRun = failed ? (detectGateCouldNotRun(combined) ?? undefined) : undefined;
  const ok = !spawnError && !timedOut && exitCode === 0 && !noTests;
  // Parse the FULL output — `outputTail` below is truncated, and a truncated
  // failure list would make the clipped-away tests look newly-failing next run.
  const parsed = kind === "test" ? parseFailingTestIds(combined) : { ids: [], formats: [] as TestRunnerFormat[] };
  // Same reason: error identities are extracted from the FULL output, never the
  // truncated tail — a clipped-away error code would look "not present" and be
  // silently attributed away.
  const errorSet = kind === "build" ? extractErrorSet(combined) : undefined;
  // Same reason again — the FULL output, before `tail()`. A coverage summary is
  // printed LAST by every runner here, so on a chatty suite the tail is where it
  // would survive; but a suite that prints a lot AFTER it (coverlet's per-module
  // table, a threshold warning) would push it out, and a clipped-away summary
  // reads as "not measured", which silently un-measures a measured run.
  //
  // THE ONLY NON-MODEL SOURCE of this number. `extractCoverageFromOutput` has
  // existed, unit-tested, since the coverage field was introduced and had zero
  // production call sites — verified by repo-wide search at 97ff484e: the only
  // non-test references were the import and re-export in `src/verify/recipes.ts`
  // lines 5 and 7. Nothing measured coverage anywhere; the field was only ever a
  // number a model chose to type.
  let coverage: number | null = null;
  if (kind === "test" && ecosystem) {
    try {
      coverage = extractCoverageFromOutput(combined, ecosystem);
    } catch (err) {
      // A parser throwing must not fail the gate — coverage is not what the
      // floor adjudicates. Recorded as unmeasured, and never silently.
      logger.warn("orchestrator", `[verify-floor] coverage parse failed for "${command}" (ecosystem=${ecosystem})`, {
        operation: "runFloorCommand",
        cwd,
        command,
        ecosystem,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
      coverage = null;
    }
  }

  if (!ok) {
    const why = spawnError
      ? `spawn-error: ${spawnError}`
      : timedOut
        ? `timed out after ${timeoutMs}ms`
        : couldNotRun
          ? `could not run (${couldNotRun.kind}): ${couldNotRun.evidence}`
          : noTests
            ? `zero tests executed (${noTests.kind}): ${noTests.evidence}`
            : `exit ${String(exitCode)}`;
    logger.warn("orchestrator", `[verify-floor] ${kind} gate FAILED — "${command}" in ${cwd}: ${why}`, {
      operation: "runFloorCommand",
      cwd,
      command,
    });
  }

  return {
    kind,
    command,
    exitCode,
    ok,
    timedOut,
    spawnError,
    outputTail: tail(combined),
    elapsedMs: Date.now() - started,
    noTests,
    couldNotRun,
    failingTests: parsed.ids,
    formats: parsed.formats,
    errorSet,
    coverage,
  };
}

/**
 * Run one git command, best-effort: a non-git directory is a legitimate working
 * tree, so any failure yields null rather than throwing.
 *
 * ## The bug this closes
 *
 * The previous version of this helper caught only a SYNCHRONOUS throw from
 * `spawnSync` itself — vanishingly rare (`spawnSync` reports failure via
 * `res.error`/`res.status`, not by throwing). The actual failure path —
 * `res.error` set, or a non-zero exit — returned `null` with NO log line at
 * all, silently. That is how run `mu54vrme4c87`'s baseline recorded
 * `gitCommit: null` while `gitBranch: "master"` resolved fine one call later:
 * `git rev-parse HEAD` failed in that cwd for a reason nothing ever recorded,
 * and the caller (and every reader of the baseline afterward) had no way to
 * tell "git isn't there" from "git failed" from "this really has no commits".
 * Every failure branch below now logs the exit code / spawn error / stderr
 * tail, per the repo's No Silent Catch rule.
 *
 * D7: the actual spawn + retry + logging now lives in the shared
 * `utils/git-spawn.ts` (`runGitSpawn`) — this wrapper only maps that result
 * back to this module's `string | null` contract so every existing caller in
 * this file is unaffected. `budget` is optional and forwarded as-is: a caller
 * making SEVERAL sequential calls (`readGitIdentity`) passes one shared
 * `GitSpawnBudget` so the whole sequence is capped at one total elapsed
 * budget instead of each call getting its own fresh one.
 */
function runGit(args: string[], cwd: string, op: string, budget?: GitSpawnBudget): string | null {
  const result = runGitSpawn(args, cwd, op, "verify-floor", budget);
  return result.ok ? result.stdout.trim() : null;
}

/** Parse `git status --porcelain` lines into plain paths, newest-safe for renames (`old -> new` keeps `new`). */
function parseDirtyPaths(statusOutput: string): string[] {
  const paths = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(2).trim();
      const arrow = rest.indexOf(" -> ");
      const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
      return p.replace(/^"(.*)"$/, "$1");
    })
    .filter(Boolean);
  return boundDirtyFiles(paths);
}

/**
 * Git identity of the tree under test. Used to stamp a baseline and to reject
 * one captured on a different branch. Best-effort: a non-git directory is a
 * legitimate working tree, so failure yields nulls rather than throwing (but,
 * per `runGit`, never silently — see the doc comment there).
 *
 * D7 (acceptance-review fix): this makes up to 4 sequential git calls. They
 * now share ONE `GitSpawnBudget` (`createGitSpawnBudget()`, default 60s
 * total) so the WHOLE identity read is capped at one total elapsed budget —
 * without this, 4 calls each retrying up to 3 attempts at a per-attempt
 * timeout could have blocked this (single, TUI-driving) thread for minutes.
 */
export function readGitIdentity(cwd: string): {
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  /** Bounded list of paths from `git status --porcelain`. Null when status could not be read. */
  dirtyFiles: string[] | null;
  /** sha256 of `git diff HEAD`. Null on a clean tree or when the diff could not be read. */
  dirtyDiffHash: string | null;
} {
  const budget = createGitSpawnBudget();
  const commit = runGit(["rev-parse", "HEAD"], cwd, "readGitIdentity", budget);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, "readGitIdentity", budget);
  const status = runGit(["status", "--porcelain"], cwd, "readGitIdentity", budget);
  if (status === null) {
    return { commit, branch, dirty: null, dirtyFiles: null, dirtyDiffHash: null };
  }
  const dirty = status.length > 0;
  const dirtyFiles = parseDirtyPaths(status);
  // Only pay for the (potentially large) diff when there is one to hash.
  const diffText = dirty ? runGit(["diff", "HEAD"], cwd, "readGitIdentity", budget) : null;
  const dirtyDiffHash = diffText && diffText.length > 0 ? sha256Hex(diffText) : null;
  return { commit, branch, dirty, dirtyFiles, dirtyDiffHash };
}

/**
 * Files that differ between the baseline's commit and the CURRENT working tree,
 * minus the files the baseline itself already recorded as dirty — i.e. files
 * THIS run touched since the baseline was captured, not ones that were already
 * different before it started. Returns null when there is no commit to diff
 * against (an old-format baseline, or one whose `gitCommit` capture failed) —
 * `attributeBuildFailure` then falls back to the error-set rule alone.
 */
function computeChangedFilesSinceBaseline(cwd: string, baseline: VerifyBaseline): string[] | null {
  if (!baseline.gitCommit) return null;
  const diffOut = runGit(["diff", "--name-only", baseline.gitCommit], cwd, "computeChangedFilesSinceBaseline");
  if (diffOut === null) return null;
  const changed = diffOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const alreadyDirtyAtBaseline = new Set(baseline.dirtyFiles ?? []);
  return changed.filter((f) => !alreadyDirtyAtBaseline.has(f));
}

/** Cap on how many test names the message spells out before switching to a count. */
const MAX_NAMED_NEW = 25;
const MAX_NAMED_PRE_EXISTING = 5;

function bulletList(ids: string[], cap: number): string {
  const shown = ids.slice(0, cap).map((id) => `  - ${id}`);
  if (ids.length > cap) shown.push(`  - …and ${ids.length - cap} more`);
  return shown.join("\n");
}

/**
 * The headline sentence. Every failure kind gets its own, because the human (or
 * agent) response differs: broke-the-build, broke-a-test, and inherited-a-red-
 * suite are three different situations that the old single sentence — "the
 * project's own gates did not pass" — collapsed into one.
 */
function headline(delta: FloorDelta): string {
  switch (delta.failureKind) {
    case "build-failed":
      if (!delta.buildAlreadyBroken) {
        return "this run BROKE THE BUILD. The build/typecheck gate failed, and no test result is attributable while it is red.";
      }
      // buildAlreadyBroken === true: the baseline was ALSO red. Which of the
      // three honest outcomes applies decides the sentence — see BuildAttribution.
      if (delta.buildAttribution === "run-introduced") {
        return "the build/typecheck gate failed, and while the baseline was ALSO red, this run's failure does not match the baseline's — this run introduced its own break. The floor cannot open until THIS run's break is fixed.";
      }
      if (delta.buildAttribution === "unattributable") {
        return "the build/typecheck gate failed, and the baseline was ALSO red, but there is not enough evidence to tell whether this run caused it or only inherited it. Treat it as this run's responsibility — the floor cannot open until it is fixed.";
      }
      // "pre-existing" (or attribution not computed by an older caller) — the
      // original, byte-identical sentence.
      return "the build/typecheck gate failed, and it was ALREADY failing at baseline. This is not this run's doing — but nothing can be verified on a broken build, so the floor cannot open until it is fixed.";
    case "test-regression":
      return `this run BROKE ${delta.newlyFailing.length} TEST(S) that were passing at baseline.`;
    case "test-unattributable":
      return "a test command failed, but its output named no failing test. The failures could not be attributed, so no baseline can excuse them.";
    case "test-absolute-no-baseline":
      return "the test gate failed and there is no baseline to compare it against.";
    case "no-tests-executed":
      return "a test command executed ZERO tests. Absence of evidence is not evidence of correctness.";
    case "gate-could-not-run":
      // Names the ENVIRONMENT as the cause, and says what to do about it. The
      // per-command line below quotes the exact evidence, so the fix loop is
      // pointed at the missing dependency instead of at the project's tests.
      return "a gate command could not RUN — its launcher, module or script is missing, so it never reached the code. This is an environment problem, NOT a test or build failure: install the missing dependency (or declare it in the project's manifest) and re-run. The floor stays closed because an un-runnable gate produces no evidence.";
    case "infra":
      return "a gate command could not be run to completion (spawn error or timeout), so it produced no evidence.";
    default:
      return "the project's own gates did not pass.";
  }
}

/**
 * Whether the raw output tail still carries information the structured summary
 * does not. For a named test regression it does not — the test names ARE the
 * evidence, and a 4000-char tail of an already-truncated log is noise. For a
 * broken build or an unattributable failure the tail is the only evidence there
 * is.
 */
function needsRawEvidence(delta: FloorDelta): boolean {
  return delta.failureKind !== "test-regression";
}

function formatFloorDetail(result: Omit<VerifyFloorResult, "detail">, testsSkipped: boolean): string {
  if (result.verdict === "unavailable") {
    return result.unavailableReason === "disabled"
      ? "Deterministic verify floor DISABLED (MUONROI_SPRINT_VERIFY_FLOOR=0) — this PASS rests on the verify sub-agent's narration alone, with no exit code behind it."
      : "Deterministic verify floor could not run: no build or test command was discoverable in the working tree. This PASS rests on the verify sub-agent's narration alone, with no exit code behind it.";
  }

  const lines = result.checks.map((c) => {
    const tolerated = c.ok ? "" : result.delta?.verdict === "pass" ? " — all failures pre-existing, tolerated" : "";
    const status = c.ok
      ? "OK"
      : c.spawnError
        ? `SPAWN-ERROR (${c.spawnError})`
        : c.timedOut
          ? "TIMEOUT"
          : c.couldNotRun
            ? `COULD-NOT-RUN (${c.couldNotRun.kind}: ${c.couldNotRun.evidence})`
            : c.noTests
              ? `NO-TESTS-EXECUTED (${c.noTests.kind}: ${c.noTests.evidence})`
              : `EXIT ${String(c.exitCode)}`;
    return `- [${c.kind}] \`${c.command}\` → ${status}${tolerated} (${c.elapsedMs}ms)`;
  });

  const delta = result.delta;
  const ruleLine = delta ? describeBaselineRule(delta) : "";

  if (result.verdict === "fail") {
    const parts: string[] = [
      `Deterministic verify floor FAILED — ${delta ? headline(delta) : "the project's own gates did not pass."}`,
    ];
    if (ruleLine) parts.push(ruleLine);
    parts.push(...lines);

    if (delta && delta.newlyFailing.length > 0) {
      // Under the absolute rule there is no baseline, so "newly" would be a
      // claim the floor cannot make — every failure is simply unattributed.
      const label =
        delta.rule === "delta"
          ? `Newly failing (${delta.newlyFailing.length}) — passing at baseline, failing now. Fix these:`
          : `Failing (${delta.newlyFailing.length}) — with no baseline the floor cannot say which of these this run caused:`;
      parts.push(`\n${label}\n${bulletList(delta.newlyFailing, MAX_NAMED_NEW)}`);
    }
    if (delta && delta.preExisting.length > 0) {
      parts.push(
        `\nAlready failing at baseline (${delta.preExisting.length}) — IGNORED ON PURPOSE, not this run's doing:\n${bulletList(delta.preExisting, MAX_NAMED_PRE_EXISTING)}`,
      );
    }

    if (!delta || needsRawEvidence(delta)) {
      const firstFail = result.checks.find((c) => !c.ok);
      const evidence = firstFail?.outputTail?.trim();
      if (evidence) parts.push(`\nFirst failing command output (tail):\n\`\`\`\n${evidence}\n\`\`\``);
    }
    return parts.filter(Boolean).join("\n");
  }

  const notes: string[] = [];
  if (ruleLine) notes.push(ruleLine);
  if (delta && delta.preExisting.length > 0) {
    notes.push(
      `NOTE: ${delta.preExisting.length} test(s) failed but were ALREADY failing at baseline, so they were ignored on purpose:\n${bulletList(delta.preExisting, MAX_NAMED_PRE_EXISTING)}`,
    );
  }
  if (delta && delta.fixed.length > 0) {
    notes.push(`NOTE: ${delta.fixed.length} test(s) that were failing at baseline now pass.`);
  }
  if (testsSkipped) {
    notes.push(
      "NOTE: the test tier was skipped (MUONROI_SPRINT_FLOOR_TESTS=0) — zero tests were executed by the floor.",
    );
  }
  return [`Deterministic verify floor PASSED.`, ...lines, ...notes].join("\n");
}

/**
 * Run the project's own gates and return a verdict backed by real exit codes.
 *
 * Build/typecheck commands run first so a compile error fails fast before the
 * (far more expensive) test tier is paid for.
 */
export async function runVerifyFloor(opts: RunVerifyFloorOpts): Promise<VerifyFloorResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? getFloorTimeoutMs();

  if (!isFloorEnabled(opts.forceEnable)) {
    const base = {
      verdict: "unavailable" as const,
      unavailableReason: "disabled" as const,
      checks: [],
      commandsDiscovered: { build: [], test: [] },
      elapsedMs: Date.now() - started,
      measuredCoverage: null,
    };
    logger.warn(
      "orchestrator",
      "[verify-floor] disabled via MUONROI_SPRINT_VERIFY_FLOOR — no deterministic evidence for this sprint",
      { operation: "runVerifyFloor", cwd: opts.cwd },
    );
    return { ...base, detail: formatFloorDetail(base, false) };
  }

  const commandsDiscovered = opts.commandsOverride ?? resolveFloorCommands(opts.cwd);
  const testsSkipped = !areFloorTestsEnabled();
  const testCommands = testsSkipped ? [] : commandsDiscovered.test;
  const planned: Array<{ kind: "build" | "test"; command: string }> = [
    ...commandsDiscovered.build.map((command) => ({ kind: "build" as const, command })),
    ...testCommands.map((command) => ({ kind: "test" as const, command })),
  ];

  if (planned.length === 0) {
    const base = {
      verdict: "unavailable" as const,
      unavailableReason: "no-commands-discovered" as const,
      checks: [],
      commandsDiscovered,
      elapsedMs: Date.now() - started,
      measuredCoverage: null,
    };
    logger.warn(
      "orchestrator",
      `[verify-floor] no build/test command discoverable in ${opts.cwd} — the sprint verdict has no deterministic evidence behind it`,
      { operation: "runVerifyFloor", cwd: opts.cwd },
    );
    return { ...base, detail: formatFloorDetail(base, testsSkipped) };
  }

  // Load the baseline BEFORE running anything: whether a red test command is a
  // regression or an inherited failure decides whether the loop below may keep
  // going, and re-reading it per command would let a mid-run edit change the rule.
  const git = readGitIdentity(opts.cwd);
  const loaded = await loadFloorBaseline({
    baselinePath: opts.baselinePath ?? resolveBaselinePathFromEnv(),
    cwd: opts.cwd,
    commands: commandsDiscovered,
    runId: opts.runId,
    gitBranch: git.branch,
  });

  // Resolved once, only when a test command will actually run — it is a second
  // disk probe and it feeds nothing but the coverage grammar.
  const ecosystem = testCommands.length > 0 ? (resolveFloorEcosystem(opts.cwd) ?? undefined) : undefined;

  const checks: FloorCheck[] = [];
  for (const { kind, command } of planned) {
    opts.onProgress?.({ phase: "start", kind, command, index: checks.length, total: planned.length });
    const check = await runFloorCommand(kind, command, opts.cwd, timeoutMs, ecosystem);
    checks.push(check);
    opts.onProgress?.({
      phase: "done",
      kind,
      command,
      index: checks.length - 1,
      total: planned.length,
      ok: check.ok,
      exitCode: check.exitCode,
      elapsedMs: check.elapsedMs,
    });
    // Stop early only when the verdict genuinely cannot recover. A test command
    // whose every failure was already failing at baseline is NOT such a case —
    // breaking there would reinstate the absolute gate through the back door.
    if (!isToleratedTestFailure(check, loaded.baseline)) break;
  }

  // Only meaningful (and only costs another git call) when a baseline actually
  // applied — used solely to attribute a build failure that was ALSO red at
  // baseline (see attributeBuildFailure).
  const changedFilesSinceBaseline = loaded.baseline
    ? computeChangedFilesSinceBaseline(opts.cwd, loaded.baseline)
    : null;
  const delta = computeFloorDelta(checks, loaded, changedFilesSinceBaseline);
  const measuredCoverage = foldMeasuredCoverage(checks);
  const base = {
    verdict: delta.verdict as FloorVerdict,
    checks,
    commandsDiscovered,
    elapsedMs: Date.now() - started,
    delta,
    measuredCoverage,
  };
  logger.info(
    "orchestrator",
    measuredCoverage === null
      ? "[verify-floor] no coverage figure in the test output — coverage is UNMEASURED for this sprint (this does not block the engineering floor)"
      : `[verify-floor] measured coverage ${(measuredCoverage * 100).toFixed(1)}% from the project's own test output`,
    { operation: "runVerifyFloor", cwd: opts.cwd, ecosystem: ecosystem ?? null, measuredCoverage },
  );
  if (delta.verdict === "fail") {
    logger.error(
      "orchestrator",
      `[verify-floor] runVerifyFloor: FAIL (${delta.failureKind}) via ${delta.rule} rule in ${opts.cwd} — ${delta.newlyFailing.length} newly failing, ${delta.preExisting.length} pre-existing ignored`,
      { operation: "runVerifyFloor", cwd: opts.cwd, failedCommand: delta.failedCommand },
    );
  }
  return { ...base, detail: formatFloorDetail(base, testsSkipped) };
}

/**
 * Capture the project's PRE-EXISTING failure set, to be gated against later.
 *
 * This must run BEFORE the loop starts changing the working tree — a baseline
 * captured after sprint 1 has already committed would launder that sprint's own
 * breakage into "pre-existing", which is exactly the hole the record's runId /
 * commit / command stamping exists to keep visible.
 *
 * It runs the same disk-derived commands the floor runs, so the two sets are
 * comparable by construction. It never throws on a red result: a red baseline is
 * the normal case in a real repository and is the whole point of capturing one.
 */
export async function captureVerifyFloorBaseline(opts: CaptureBaselineOpts): Promise<CaptureBaselineResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? getFloorTimeoutMs();
  const commands = opts.commandsOverride ?? resolveFloorCommands(opts.cwd);
  const destination =
    opts.baselinePath ??
    (opts.flowDir
      ? verifyBaselinePath(opts.flowDir, opts.runId)
      : (() => {
          throw new Error("captureVerifyFloorBaseline: one of baselinePath or flowDir is required");
        })());

  const results: VerifyBaselineCommandResult[] = [];
  let buildOk = true;
  let unattributable = false;
  const failingTests = new Set<string>();

  const plannedTotal = commands.build.length + commands.test.length;
  let plannedIndex = 0;
  for (const command of commands.build) {
    opts.onProgress?.({ phase: "start", kind: "build", command, index: plannedIndex, total: plannedTotal });
    const c = await runFloorCommand("build", command, opts.cwd, timeoutMs);
    opts.onProgress?.({
      phase: "done",
      kind: "build",
      command,
      index: plannedIndex,
      total: plannedTotal,
      ok: c.ok,
      exitCode: c.exitCode,
      elapsedMs: c.elapsedMs,
    });
    plannedIndex += 1;
    results.push({
      kind: "build",
      command,
      exitCode: c.exitCode,
      ok: c.ok,
      failingTests: [],
      formats: [],
      ...(c.ok ? {} : { failureSignature: buildFailureSignature(c.outputTail), errorSet: c.errorSet ?? [] }),
    });
    if (!c.ok) {
      buildOk = false;
      // A red build makes the test tier meaningless — record it and stop.
      break;
    }
  }

  if (buildOk) {
    for (const command of commands.test) {
      opts.onProgress?.({ phase: "start", kind: "test", command, index: plannedIndex, total: plannedTotal });
      const c = await runFloorCommand("test", command, opts.cwd, timeoutMs);
      opts.onProgress?.({
        phase: "done",
        kind: "test",
        command,
        index: plannedIndex,
        total: plannedTotal,
        ok: c.ok,
        exitCode: c.exitCode,
        elapsedMs: c.elapsedMs,
      });
      plannedIndex += 1;
      const ids = c.failingTests ?? [];
      for (const id of ids) failingTests.add(id);
      // A failing test command we cannot attribute poisons the baseline: it
      // would otherwise excuse every future failure of that same command.
      if (!c.ok && ids.length === 0) unattributable = true;
      results.push({
        kind: "test",
        command,
        exitCode: c.exitCode,
        ok: c.ok,
        failingTests: ids,
        formats: c.formats ?? [],
        ...(c.ok ? {} : { failureSignature: buildFailureSignature(c.outputTail), errorSet: ids }),
      });
    }
  }

  const git = readGitIdentity(opts.cwd);
  const baseline: VerifyBaseline = {
    version: VERIFY_BASELINE_VERSION,
    runId: opts.runId,
    capturedAtUtc: new Date().toISOString(),
    cwd: opts.cwd,
    gitCommit: git.commit,
    gitBranch: git.branch,
    gitDirty: git.dirty,
    dirtyFiles: git.dirtyFiles ?? undefined,
    dirtyDiffHash: git.dirtyDiffHash,
    commands,
    buildOk,
    failingTests: [...failingTests].sort(),
    results,
    unattributable,
    // Measured BEFORE the write, so it is the cost of the commands themselves
    // and not of persisting the record. This is the number the verify stage's
    // budget is derived from — see `computeVerifyBudget` in sprint-runner.ts.
    elapsedMs: Date.now() - started,
  };

  try {
    await writeVerifyBaseline(destination, baseline);
  } catch (err) {
    logger.error(
      "orchestrator",
      `[verify-floor] captureVerifyFloorBaseline: write failed for ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      { operation: "captureVerifyFloorBaseline", cwd: opts.cwd, runId: opts.runId },
    );
    throw err;
  }

  logger.info(
    "orchestrator",
    `[verify-floor] baseline captured for run ${opts.runId}: buildOk=${buildOk}, ${baseline.failingTests.length} pre-existing test failure(s), unattributable=${unattributable}`,
    { operation: "captureVerifyFloorBaseline", path: destination, elapsedMs: Date.now() - started },
  );

  return { baseline, path: destination, elapsedMs: Date.now() - started };
}

/**
 * Fold the floor's result into the sprint verdict.
 *
 * The floor is authoritative in BOTH directions — but only over the verdicts it
 * is entitled to speak for, and only when it actually ran.
 *
 * ## Why it now upgrades, and why that was the whole bug
 *
 * The floor used to run only when the model had already claimed PASS, so it
 * could veto but never admit. Measured, run `mttwpmu8ee5b`: the baseline was
 * captured successfully (`buildOk=true`, 31 pre-existing failures, 53s of real
 * work) and then never read, because the model's verdict came back UNKNOWN
 * rather than PASS. Both sprints ended `failedCondition: "engineering_floor"`,
 * `score: 0`, and the run shipped nothing — gated by a model narration while a
 * green delta from the project's own build and test commands sat unused.
 *
 * ## UNKNOWN and FAIL are NOT the same input, and are not treated the same
 *
 * - `UNKNOWN` is the ABSENCE of a claim: the sub-agent emitted neither verdict
 *   marker (it ran out of steps, wandered, or its narration was polluted). There
 *   is nothing to contradict, so the floor may supply the verdict the model
 *   failed to. Exit codes are strictly better evidence than silence.
 * - `FAIL` is a POSITIVE claim: the sub-agent looked at its own run and reported
 *   failure. Overriding that is a categorically stronger and more dangerous
 *   assertion — the model may have observed something the floor's command set
 *   cannot (a smoke step, a browser phase, a runtime crash outside the test
 *   runner). A green build does not disprove it. So FAIL is never upgraded.
 * - `ERROR` means the verify machinery itself broke (`tr.error` set). The floor
 *   speaks to the code under test, not to the harness that could not run, so it
 *   is never upgraded either.
 *
 * ## What is unchanged
 *
 * - A floor FAIL still overrides a claimed PASS (the original downgrade).
 * - A floor that could NOT run (`unavailable`) changes nothing in either
 *   direction: it must not manufacture a FAIL (that would brick every project
 *   the recipe profiler does not recognise, and every greenfield sprint 1), and
 *   it obviously cannot manufacture a PASS. It only returns a note saying, in
 *   the sprint's own transcript, that nothing deterministic stands behind the
 *   verdict.
 */
export function applyVerifyFloor(
  current: VerifyVerdict,
  floor: VerifyFloorResult,
): { verdict: VerifyVerdict; downgraded: boolean; upgraded: boolean; note: string } {
  // No evidence either way — today's behaviour, deliberately preserved.
  if (floor.verdict === "unavailable") {
    return { verdict: current, downgraded: false, upgraded: false, note: floor.detail };
  }

  if (floor.verdict === "fail") {
    // Only a claimed PASS is contradicted. FAIL is already FAIL; ERROR and
    // UNKNOWN both already fail the engineering floor, and rewriting them here
    // would change failure-signature routing for no gain in the verdict.
    if (current === "PASS") {
      return { verdict: "FAIL", downgraded: true, upgraded: false, note: floor.detail };
    }
    return { verdict: current, downgraded: false, upgraded: false, note: floor.detail };
  }

  // floor.verdict === "pass" — the project's own build/typecheck and test
  // commands ran to completion and produced no regression against the baseline.
  if (current === "UNKNOWN") {
    return { verdict: "PASS", downgraded: false, upgraded: true, note: floor.detail };
  }
  return { verdict: current, downgraded: false, upgraded: false, note: floor.detail };
}

/**
 * Read back THIS RUN'S measured cost of one build+test pass, in ms.
 *
 * The number `captureVerifyFloorBaseline` recorded at run start, read by the
 * sprint loop to size the verify stage's watchdog (see `computeVerifyBudget` in
 * sprint-runner.ts). Returns null whenever no usable measurement exists.
 *
 * WHY THIS IS NOT `loadFloorBaseline`. That loader answers a different question
 * — "may this record excuse a failing test?" — and is deliberately strict about
 * it: it rejects on `commands-changed`, `different-branch` and
 * `baseline-unattributable` (`baselineRejectReason` in verify-baseline.ts), and
 * it re-derives the command set from disk to do so. Every one of those
 * rejections is correct for authorising a failure and wrong for sizing a clock:
 * a run that switched branch mid-flight, or whose baseline could not attribute
 * its own failures, still measured how long this project takes to build and
 * test. Using the strict loader here would silently drop the budget back to the
 * floor for reasons that say nothing about duration.
 *
 * So the checks here are exactly the two that bear on whether the NUMBER means
 * what we think: the record must be a version this code understands, and it must
 * belong to the run asking (another run's tree is a different amount of code).
 *
 * Never throws — a missing baseline is an ordinary state (the capture is skipped
 * when the floor is disabled) and the caller falls back to the floor budget.
 * Unexpected failures are logged per the No Silent Catch rule.
 */
export async function readBaselineVerifyCostMs(baselinePath: string, runId?: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(baselinePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is the normal "no baseline was captured for this run" case.
    if (code !== "ENOENT") {
      logger.warn("orchestrator", `[verify-floor] readBaselineVerifyCostMs: read failed for ${baselinePath}`, {
        operation: "readBaselineVerifyCostMs",
        path: baselinePath,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  let parsed: VerifyBaseline;
  try {
    parsed = JSON.parse(raw) as VerifyBaseline;
  } catch (err) {
    logger.warn("orchestrator", `[verify-floor] readBaselineVerifyCostMs: JSON parse failed for ${baselinePath}`, {
      operation: "readBaselineVerifyCostMs",
      path: baselinePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== VERIFY_BASELINE_VERSION) return null;
  if (runId && parsed.runId !== runId) return null;

  const ms = parsed.elapsedMs;
  // Absence means "not measured", never zero — a 0 would derive a 0 budget.
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}
