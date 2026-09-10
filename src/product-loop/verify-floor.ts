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

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { VerifyRecipe } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { inferVerifyProjectProfile } from "../verify/recipes.js";
import { parseFailingTestIds, type TestRunnerFormat } from "./test-failure-parse.js";
import {
  computeFloorDelta,
  describeBaselineRule,
  type FloorDelta,
  isToleratedTestFailure,
  loadFloorBaseline,
  resolveBaselinePathFromEnv,
  VERIFY_BASELINE_VERSION,
  type VerifyBaseline,
  type VerifyBaselineCommandResult,
  verifyBaselinePath,
  writeVerifyBaseline,
} from "./verify-baseline.js";
import { detectNoTestsExecuted, type NoTestsSignal, type VerifyVerdict } from "./verify-result.js";

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
   * Failing test identities parsed from this command's FULL output — computed
   * here, before `outputTail` truncates, because a clipped list would make the
   * clipped-away failures look newly-failing on the next run.
   */
  failingTests?: string[];
  /** Which runner grammars produced those identities. Empty when none matched. */
  formats?: TestRunnerFormat[];
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
 */
export async function runFloorCommand(
  kind: "build" | "test",
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<FloorCheck> {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let spawnError: string | undefined;

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
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun();
    };
    const timer = setTimeout(() => {
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

    // Bound what we hold in memory, the way spawnSync's maxBuffer did — but
    // WITHOUT killing the run: a chatty-but-green build must not be scored as a
    // failure just because it printed a lot.
    let captured = 0;
    const sink = (which: "out" | "err") => (buf: Buffer | string) => {
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
  const ok = !spawnError && !timedOut && exitCode === 0 && !noTests;
  // Parse the FULL output — `outputTail` below is truncated, and a truncated
  // failure list would make the clipped-away tests look newly-failing next run.
  const parsed = kind === "test" ? parseFailingTestIds(combined) : { ids: [], formats: [] as TestRunnerFormat[] };

  if (!ok) {
    const why = spawnError
      ? `spawn-error: ${spawnError}`
      : timedOut
        ? `timed out after ${timeoutMs}ms`
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
    failingTests: parsed.ids,
    formats: parsed.formats,
  };
}

/**
 * Git identity of the tree under test. Used to stamp a baseline and to reject
 * one captured on a different branch. Best-effort: a non-git directory is a
 * legitimate working tree, so failure yields nulls rather than throwing.
 */
export function readGitIdentity(cwd: string): { commit: string | null; branch: string | null; dirty: boolean | null } {
  const run = (args: string[]): string | null => {
    try {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
      if (res.error || res.status !== 0) return null;
      return (res.stdout ?? "").trim();
    } catch (err) {
      logger.warn(
        "orchestrator",
        `[verify-floor] readGitIdentity: git ${args.join(" ")} failed in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
        { operation: "readGitIdentity", cwd },
      );
      return null;
    }
  };
  const commit = run(["rev-parse", "HEAD"]);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  return { commit, branch, dirty: status === null ? null : status.length > 0 };
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
      return delta.buildAlreadyBroken
        ? "the build/typecheck gate failed, and it was ALREADY failing at baseline. This is not this run's doing — but nothing can be verified on a broken build, so the floor cannot open until it is fixed."
        : "this run BROKE THE BUILD. The build/typecheck gate failed, and no test result is attributable while it is red.";
    case "test-regression":
      return `this run BROKE ${delta.newlyFailing.length} TEST(S) that were passing at baseline.`;
    case "test-unattributable":
      return "a test command failed, but its output named no failing test. The failures could not be attributed, so no baseline can excuse them.";
    case "test-absolute-no-baseline":
      return "the test gate failed and there is no baseline to compare it against.";
    case "no-tests-executed":
      return "a test command executed ZERO tests. Absence of evidence is not evidence of correctness.";
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

  const checks: FloorCheck[] = [];
  for (const { kind, command } of planned) {
    opts.onProgress?.({ phase: "start", kind, command, index: checks.length, total: planned.length });
    const check = await runFloorCommand(kind, command, opts.cwd, timeoutMs);
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

  const delta = computeFloorDelta(checks, loaded);
  const base = {
    verdict: delta.verdict as FloorVerdict,
    checks,
    commandsDiscovered,
    elapsedMs: Date.now() - started,
    delta,
  };
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
    results.push({ kind: "build", command, exitCode: c.exitCode, ok: c.ok, failingTests: [], formats: [] });
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
    commands,
    buildOk,
    failingTests: [...failingTests].sort(),
    results,
    unattributable,
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
