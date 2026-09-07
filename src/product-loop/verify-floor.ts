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
 */

import { spawnSync } from "node:child_process";
import type { VerifyRecipe } from "../types/index.js";
import { inferVerifyProjectProfile } from "../verify/recipes.js";
import { detectNoTestsExecuted, type NoTestsSignal, type VerifyVerdict } from "./verify-result.js";

/** Per-command wall-clock budget. Mirrors the verify watchdog's 10-minute default. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap captured output so a chatty runner cannot blow up the sprint feedback. */
const OUTPUT_TAIL_CHARS = 4000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type FloorVerdict = "pass" | "fail" | "unavailable";

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
    console.error(
      `[verify-floor] command discovery failed for cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      { stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined },
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
export function runFloorCommand(kind: "build" | "test", command: string, cwd: string, timeoutMs: number): FloorCheck {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let spawnError: string | undefined;

  try {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      // The gate must never wait on a prompt; keep stdin closed.
      stdio: ["ignore", "pipe", "pipe"],
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
    exitCode = res.status;
    // spawnSync sets `signal` (and error.code ETIMEDOUT) when the timeout fires.
    timedOut = res.signal !== null && res.signal !== undefined;
    if (res.error) {
      spawnError = res.error.message;
      if ((res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") timedOut = true;
    }
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
    console.error(`[verify-floor] spawn threw for ${kind} command "${command}" in ${cwd}: ${spawnError}`, {
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
  }

  const combined = `${stdout}${stderr}`;
  const noTests = kind === "test" ? (detectNoTestsExecuted(combined) ?? undefined) : undefined;
  const ok = !spawnError && !timedOut && exitCode === 0 && !noTests;

  if (!ok) {
    const why = spawnError
      ? `spawn-error: ${spawnError}`
      : timedOut
        ? `timed out after ${timeoutMs}ms`
        : noTests
          ? `zero tests executed (${noTests.kind}): ${noTests.evidence}`
          : `exit ${String(exitCode)}`;
    console.error(`[verify-floor] ${kind} gate FAILED — "${command}" in ${cwd}: ${why}`);
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
  };
}

function formatFloorDetail(result: Omit<VerifyFloorResult, "detail">, testsSkipped: boolean): string {
  if (result.verdict === "unavailable") {
    return result.unavailableReason === "disabled"
      ? "Deterministic verify floor DISABLED (MUONROI_SPRINT_VERIFY_FLOOR=0) — this PASS rests on the verify sub-agent's narration alone, with no exit code behind it."
      : "Deterministic verify floor could not run: no build or test command was discoverable in the working tree. This PASS rests on the verify sub-agent's narration alone, with no exit code behind it.";
  }

  const lines = result.checks.map((c) => {
    const status = c.ok
      ? "OK"
      : c.spawnError
        ? `SPAWN-ERROR (${c.spawnError})`
        : c.timedOut
          ? "TIMEOUT"
          : c.noTests
            ? `NO-TESTS-EXECUTED (${c.noTests.kind}: ${c.noTests.evidence})`
            : `EXIT ${String(c.exitCode)}`;
    return `- [${c.kind}] \`${c.command}\` → ${status} (${c.elapsedMs}ms)`;
  });

  if (result.verdict === "fail") {
    const firstFail = result.checks.find((c) => !c.ok);
    const evidence = firstFail?.outputTail?.trim();
    return [
      "Deterministic verify floor FAILED — the project's own gates did not pass.",
      ...lines,
      evidence ? `\nFirst failing command output (tail):\n\`\`\`\n${evidence}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const caveat = testsSkipped
    ? "\nNOTE: the test tier was skipped (MUONROI_SPRINT_FLOOR_TESTS=0) — zero tests were executed by the floor."
    : "";
  return `Deterministic verify floor PASSED.\n${lines.join("\n")}${caveat}`;
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
    console.error("[verify-floor] disabled via MUONROI_SPRINT_VERIFY_FLOOR — no deterministic evidence for this sprint");
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
    console.error(
      `[verify-floor] no build/test command discoverable in ${opts.cwd} — sprint PASS has no deterministic evidence behind it`,
    );
    return { ...base, detail: formatFloorDetail(base, testsSkipped) };
  }

  const checks: FloorCheck[] = [];
  for (const { kind, command } of planned) {
    const check = runFloorCommand(kind, command, opts.cwd, timeoutMs);
    checks.push(check);
    // Fail fast: once a gate is red the verdict cannot recover, and continuing
    // would spend minutes of test time to learn nothing new.
    if (!check.ok) break;
  }

  const base = {
    verdict: (checks.every((c) => c.ok) ? "pass" : "fail") as FloorVerdict,
    checks,
    commandsDiscovered,
    elapsedMs: Date.now() - started,
  };
  return { ...base, detail: formatFloorDetail(base, testsSkipped) };
}

/**
 * Fold the floor's result into the sprint verdict.
 *
 * A floor FAIL overrides a claimed PASS — that is the entire point of the
 * module. A floor that could not run does NOT manufacture a FAIL (that would
 * brick every project whose ecosystem the recipe profiler does not recognise,
 * and every greenfield sprint 1 that has not created a project yet); it leaves
 * the verdict alone but returns a note saying, in the sprint's own transcript,
 * that nothing deterministic stands behind the PASS.
 */
export function applyVerifyFloor(
  current: VerifyVerdict,
  floor: VerifyFloorResult,
): { verdict: VerifyVerdict; downgraded: boolean; note: string } {
  if (current !== "PASS") {
    return { verdict: current, downgraded: false, note: "" };
  }
  if (floor.verdict === "fail") {
    return { verdict: "FAIL", downgraded: true, note: floor.detail };
  }
  return { verdict: current, downgraded: false, note: floor.detail };
}
