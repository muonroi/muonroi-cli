/**
 * src/utils/git-spawn.ts
 *
 * D7 — shared, resilient `git` spawn helper.
 *
 * `product-loop/verify-floor.ts` (`readGitIdentity`) and
 * `product-loop/project-registration-check.ts`
 * (`computeAddedFilesSinceBaseline`) each carried their OWN copy of a
 * `runGit` helper — deliberately kept separate so `project-registration-check.ts`
 * never depends on `verify-floor.ts` and creates an import cycle back into
 * `verify-baseline.ts` — with a fixed 15s `spawnSync` timeout and NO retry.
 *
 * On a loaded dev machine (many concurrent worktrees) that timeout is too
 * tight: both call sites hit `spawnSync git ETIMEDOUT` in the SAME run
 * (`mu75rurpf9ec`), which silently degraded S6's project-registration check
 * (`addedFilesSource: "git-status-fallback"`, `addedFilesCount: 0` — blind to
 * the exact stale-solution-path defect S6 exists to catch) and lost the
 * verify-floor baseline's commit a second time.
 *
 * This module is the single, cycle-free home both call sites import: it
 * lives in `src/utils/`, which every product-loop module already depends on
 * for `logger.js`, so pulling this helper in creates no new dependency edge
 * and no cycle.
 *
 * ## The TOTAL budget (acceptance-review fix)
 *
 * A naive per-attempt retry is not enough: 3 attempts x a generous per-attempt
 * timeout can block the single JS thread — which also drives the TUI — for
 * minutes, and a caller like `readGitIdentity` makes 3-4 such calls in
 * sequence. This repo has a documented history of event-loop freezes
 * (`project_event_loop_freeze.md`), so a "resilient" retry that can itself
 * freeze the thread for minutes is not an improvement.
 *
 * Every call is bounded by a TOTAL elapsed budget (`GitSpawnBudget`), not just
 * a per-attempt timeout: the per-attempt timeout is clamped to whatever is
 * left of the budget, and a retry never fires once the budget is spent. A
 * caller that makes several sequential git calls for one logical operation
 * (`readGitIdentity`, `computeAddedFilesSinceBaseline`) creates ONE budget via
 * `createGitSpawnBudget()` and passes it to every call, so the WHOLE
 * operation — not each individual call — is capped at the total budget.
 */
import { spawnSync } from "node:child_process";
import { logger } from "./logger.js";

export interface GitSpawnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Present only on failure — the spawn-level error message, or
   * "git <args> exited N: <stderr tail>" for a real (non-retried) git verdict,
   * or a budget-exhaustion message. */
  error?: string;
  /** How many `spawnSync` attempts this call actually made. Can be 0 when the
   * shared budget was already spent before this call got to try at all. */
  attempts: number;
}

/**
 * A shared elapsed-time budget for one logical operation that may issue
 * several sequential `runGitSpawn` calls. Immutable once created — there is
 * no "extend"; a spent budget stays spent for every call that shares it.
 */
export interface GitSpawnBudget {
  /** Absolute `Date.now()`-based deadline. Every attempt across every call
   * sharing this budget must start (and be clamped to finish) before this. */
  readonly deadlineAt: number;
}

/**
 * Create a fresh budget. Callers that make MULTIPLE sequential git calls for
 * one logical operation (e.g. `readGitIdentity`'s 4 calls) MUST create ONE of
 * these and pass it to every call, so the whole operation shares one cap
 * instead of each call getting its own fresh budget (which would let N calls
 * cost up to N x the budget).
 */
export function createGitSpawnBudget(totalMs?: number): GitSpawnBudget {
  return { deadlineAt: Date.now() + (totalMs ?? getGitSpawnTotalBudgetMs()) };
}

const DEFAULT_GIT_SPAWN_TIMEOUT_MS = 20_000;

/**
 * Default TOTAL elapsed budget for one `runGitSpawn` call (or, when a
 * `GitSpawnBudget` is shared, for the WHOLE sequence of calls using it).
 * Sized so the worst case (every attempt times out) still lands comfortably
 * under the "freezes the TUI for minutes" line: 3 attempts x 20s (the default
 * per-attempt timeout, itself clamped down further as the budget is spent)
 * plus backoff fits inside this single 60s ceiling rather than multiplying
 * past it.
 */
const DEFAULT_GIT_SPAWN_TOTAL_BUDGET_MS = 60_000;

/**
 * Spawn-level error codes worth retrying — the fork/exec itself failed to
 * even run to completion (a dead or overloaded machine), never a real git
 * verdict. A genuine non-zero exit (not a repo, bad ref, merge conflict, …)
 * is NEVER in this set and is never retried — retrying it would not change
 * the answer.
 */
const RETRYABLE_SPAWN_CODES = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM"]);

/** Total retries after the first attempt (3 attempts total, budget permitting). */
const MAX_RETRIES = 2;

/** Backoff between attempts, doubling from this base: 300ms, then 600ms —
 * clamped down further if the remaining budget is smaller than the backoff. */
const BACKOFF_BASE_MS = 300;

/** Below this much remaining budget, a retry is not worth attempting — a
 * `git` fork/exec has real fixed overhead even before the OS gets to run it. */
const MIN_RETRY_HEADROOM_MS = 200;

/**
 * `MUONROI_GIT_SPAWN_TIMEOUT_MS` — per-attempt `spawnSync` timeout ceiling.
 * The ACTUAL per-attempt timeout used is `min(this, time left in the budget)`
 * — this value is only ever a ceiling, never a guarantee that an attempt gets
 * this long. Unset/blank falls back to the default silently; an invalid value
 * (non-numeric, non-positive, non-integer) is logged and still falls back to
 * the default — same discipline as `getNoProgressSprintLimit`
 * (`product-loop/sprint-progress.ts`).
 */
export function getGitSpawnTimeoutMs(): number {
  const raw = process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GIT_SPAWN_TIMEOUT_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
  console.error(
    `[git-spawn] ignoring MUONROI_GIT_SPAWN_TIMEOUT_MS=${JSON.stringify(raw)} (needs a positive integer ms); using ${DEFAULT_GIT_SPAWN_TIMEOUT_MS}`,
  );
  return DEFAULT_GIT_SPAWN_TIMEOUT_MS;
}

/**
 * `MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS` — the TOTAL elapsed-time cap described
 * above, per `GitSpawnBudget`. Same validation discipline as
 * `getGitSpawnTimeoutMs` / `getNoProgressSprintLimit`: invalid values are
 * logged and ignored, never silently mis-applied.
 */
export function getGitSpawnTotalBudgetMs(): number {
  const raw = process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GIT_SPAWN_TOTAL_BUDGET_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
  console.error(
    `[git-spawn] ignoring MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS=${JSON.stringify(raw)} (needs a positive integer ms); using ${DEFAULT_GIT_SPAWN_TOTAL_BUDGET_MS}`,
  );
  return DEFAULT_GIT_SPAWN_TOTAL_BUDGET_MS;
}

/**
 * Blocking sleep for the retry backoff. Every caller of `runGitSpawn` is
 * already fully synchronous (`spawnSync` itself blocks the event loop for up
 * to the timeout on each attempt), so a synchronous backoff here keeps that
 * contract instead of forcing every caller through this module to become
 * async just to retry a git spawn.
 */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // No Silent Catch: a failed backoff sleep is harmless (the retry just
    // fires immediately instead of after a delay) but must still be logged.
    logger.warn(
      "orchestrator",
      `[git-spawn] backoff sleep failed, retrying immediately: ${err instanceof Error ? err.message : String(err)}`,
      { ms },
    );
  }
}

/**
 * Run one git command with a bounded retry on a SPAWN-level failure only,
 * itself bounded by a TOTAL elapsed budget (see the module doc) so a
 * degraded machine cannot block the calling thread for minutes.
 *
 * `op` names the calling operation (e.g. `"readGitIdentity"`) and `logTag`
 * names the calling module (e.g. `"verify-floor"`) so a shared helper's log
 * lines stay attributable to their real call site, matching the format each
 * module's own former local `runGit` used.
 *
 * `budget` is optional: omit it for a single, standalone call (a fresh
 * budget is created internally, scoped to just this call). Pass a budget
 * created once via `createGitSpawnBudget()` when making SEVERAL sequential
 * calls for one logical operation, so they share one total cap instead of
 * each getting its own.
 */
export function runGitSpawn(
  args: string[],
  cwd: string,
  op: string,
  logTag: string,
  budget?: GitSpawnBudget,
): GitSpawnResult {
  const activeBudget = budget ?? createGitSpawnBudget();
  const perAttemptCeiling = getGitSpawnTimeoutMs();
  const totalAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const remainingBeforeAttempt = activeBudget.deadlineAt - Date.now();
    if (remainingBeforeAttempt <= 0) {
      const message = `git spawn budget exhausted before attempt ${attempt}/${totalAttempts}`;
      logger.warn("orchestrator", `[${logTag}] ${op}: ${message} (git ${args.join(" ")} in ${cwd})`, {
        operation: op,
        cwd,
        args,
        attempt,
      });
      return { ok: false, stdout: "", stderr: "", error: message, attempts: attempt - 1 };
    }
    // The per-attempt timeout is a CEILING, clamped to whatever is actually
    // left of the total budget — this is what stops 3 x a generous
    // per-attempt timeout from multiplying past the total cap.
    const timeout = Math.max(1, Math.floor(Math.min(perAttemptCeiling, remainingBeforeAttempt)));

    let res: import("node:child_process").SpawnSyncReturns<string>;
    try {
      res = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException)?.code;
      logger.warn(
        "orchestrator",
        `[${logTag}] ${op}: git ${args.join(" ")} threw in ${cwd} (attempt ${attempt}/${totalAttempts}): ${message}`,
        { operation: op, cwd, args, attempt, code },
      );
      const remainingAfter = activeBudget.deadlineAt - Date.now();
      if (
        code &&
        RETRYABLE_SPAWN_CODES.has(code) &&
        attempt < totalAttempts &&
        remainingAfter > MIN_RETRY_HEADROOM_MS
      ) {
        sleepSyncMs(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), remainingAfter));
        continue;
      }
      return { ok: false, stdout: "", stderr: "", error: message, attempts: attempt };
    }

    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      logger.warn(
        "orchestrator",
        `[${logTag}] ${op}: git ${args.join(" ")} failed to spawn in ${cwd} (attempt ${attempt}/${totalAttempts}): ${res.error.message}`,
        { operation: op, cwd, args, attempt, code },
      );
      const remainingAfter = activeBudget.deadlineAt - Date.now();
      if (
        code &&
        RETRYABLE_SPAWN_CODES.has(code) &&
        attempt < totalAttempts &&
        remainingAfter > MIN_RETRY_HEADROOM_MS
      ) {
        sleepSyncMs(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), remainingAfter));
        continue;
      }
      return { ok: false, stdout: "", stderr: "", error: res.error.message, attempts: attempt };
    }

    if (res.status !== 0) {
      const stderrTail = (res.stderr ?? "").trim().slice(0, 500);
      const error = `git ${args.join(" ")} exited ${res.status}: ${stderrTail}`;
      logger.warn(
        "orchestrator",
        `[${logTag}] ${op}: git ${args.join(" ")} exited ${res.status} in ${cwd}: ${stderrTail}`,
        { operation: op, cwd, args, status: res.status, attempt },
      );
      // A real git verdict, not a spawn failure — never retried.
      return { ok: false, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error, attempts: attempt };
    }

    return { ok: true, stdout: res.stdout ?? "", stderr: res.stderr ?? "", attempts: attempt };
  }

  // Unreachable in practice (the loop's last iteration always returns — see
  // `attempt < totalAttempts` above), but TypeScript's control-flow analysis
  // can't prove that for a dynamically-bounded loop. Degrades honestly with
  // the same shape as a single failed attempt rather than returning `undefined`.
  return { ok: false, stdout: "", stderr: "", error: "git spawn retries exhausted", attempts: totalAttempts };
}
