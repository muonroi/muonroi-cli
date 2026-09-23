/**
 * src/product-loop/verify-baseline.ts
 *
 * The BASELINE the deterministic verify floor gates against.
 *
 * ## The bug this closes
 *
 * `verify-floor.ts` compared the project's own gates against ZERO failures. That
 * is only a sound gate in a repository whose suite is already green. Measured on
 * `/ideal` against `D:\sources\CompanyLibs\tcis-libraries` (run `mttwpmu8ee5b`,
 * 98 minutes): both sprints ended
 * `failedCondition: "engineering_floor"`, `score: 0`, with
 *
 *     [build] dotnet build "src\TCISLibraries.sln" --no-restore  → OK  (32733ms)
 *     [test]  dotnet test  "src\TCISLibraries.sln" --no-build    → EXIT 1 (13673ms)
 *
 * The 31 failing tests were three infrastructure-dependent assemblies
 * (PostgreSql 19, SqlServer 7, Kafka 5) failing in 15-35ms apiece for want of a
 * live database and broker. 38 other assemblies passed. The build passed both
 * times. Nothing that failed was touched by the run. The floor was therefore
 * unsatisfiable in that repository, and every other improvement to the loop was
 * invisible behind a gate that could not open.
 *
 * The fix is to gate on the DELTA: record which tests were already failing
 * BEFORE the loop began changing things, and fail only when the run makes it
 * worse.
 *
 * ## The fallback rule, and why it goes this way
 *
 * When no usable baseline exists the floor falls back to ABSOLUTE — exactly
 * today's behaviour — and says so in the failure message.
 *
 * The two directions are not symmetric in DETECTABILITY:
 *
 *   - Absolute-on-missing fails loudly, at sprint 1, with a message that names
 *     the pre-existing failures, names the rule that produced the verdict, and
 *     names the remedy. A human sees the problem in the first minute.
 *   - Permissive-on-missing (treat "no baseline" as "everything is allowed")
 *     produces a PASS that is indistinguishable in the transcript from a
 *     genuinely green run — which is the precise failure this floor was built to
 *     prevent.
 *
 * It is also the only choice that is not forgeable. If a missing baseline meant
 * "allow everything", then deleting or corrupting one file would disarm the
 * floor entirely — the same class of hole as taking the gate commands from the
 * model's own recipe, which `verify-floor.ts` already refuses to do.
 *
 * A gate whose evidence is missing must not open. It must say why it stayed
 * shut.
 *
 * ## Staleness — a baseline is scoped, never ambient
 *
 * A baseline authorises failures, so a wrong one is a hole. Every record carries
 * the run id, working tree, git commit + branch, and the exact command set it
 * was measured with; `loadFloorBaseline` rejects any record that does not match
 * the run asking. A baseline from another run, another branch, or a changed
 * command set is REJECTED, which falls back to the absolute rule rather than
 * silently authorising a broken suite.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteJSON } from "../storage/atomic-io.js";
import { logger } from "../utils/logger.js";
import type { TestRunnerFormat } from "./test-failure-parse.js";

/** Bumped whenever the record's meaning changes; an older record is rejected, never guessed at. */
export const VERIFY_BASELINE_VERSION = 1;

export const VERIFY_BASELINE_FILENAME = "verify-baseline.json";

/** Point the floor at a captured baseline without a code change. Absolute path to a baseline JSON. */
export const VERIFY_BASELINE_ENV = "MUONROI_SPRINT_FLOOR_BASELINE";

export interface VerifyBaselineCommandResult {
  kind: "build" | "test";
  command: string;
  exitCode: number | null;
  ok: boolean;
  /** Failing test identities parsed from this command's FULL output. */
  failingTests: string[];
  formats: TestRunnerFormat[];
  /**
   * Bounded, normalized tail of this command's FULL output — absolute paths and
   * timestamps replaced with placeholders so two captures of the same failure in
   * different working trees compare equal. Only set when the command failed.
   * OPTIONAL: a baseline written before this field existed lacks it (see
   * `attributeBuildFailure`, which treats absence as "no stored signature", never
   * as an empty one).
   */
  failureSignature?: string;
  /**
   * The set of error identities extracted from this command's FULL output: for a
   * build/typecheck command, normalized lines naming a recognisable error code
   * (`NU1107`, `CS0103`, `TS2345`, `MSB...`); for a test command, the failing test
   * names (same values as `failingTests`). Used to tell "the same failure as the
   * baseline" from "a new one this run introduced" — see `attributeBuildFailure`.
   * Only set when the command failed. OPTIONAL for the same backward-compat
   * reason as `failureSignature`.
   */
  errorSet?: string[];
}

export interface VerifyBaseline {
  version: number;
  /** The /ideal run this baseline belongs to. A record from another run never applies. */
  runId: string;
  capturedAtUtc: string;
  /** Absolute working tree the commands were executed in. */
  cwd: string;
  gitCommit: string | null;
  gitBranch: string | null;
  /** Whether the tree had uncommitted changes at capture time. Recorded, not enforced. */
  gitDirty: boolean | null;
  /**
   * Paths reported by `git status --porcelain` at capture time, bounded to
   * `MAX_DIRTY_FILES` entries. Null when git status could not be read (mirrors
   * `gitDirty: null`). Empty array means a confirmed-clean tree.
   *
   * OPTIONAL, not a version bump: a record written before this field existed
   * simply lacks it — `attributeBuildFailure` reads that as "unknown", never as
   * "confirmed empty".
   */
  dirtyFiles?: string[];
  /**
   * sha256 of `git diff HEAD` at capture time, or null when the tree was clean or
   * the diff could not be read. Recorded so a future run could detect that a
   * baseline's dirty state changed shape without re-deriving the whole diff; nothing
   * reads it yet. OPTIONAL for the same reason as `dirtyFiles`.
   */
  dirtyDiffHash?: string | null;
  commands: { build: string[]; test: string[] };
  /** False when a build/typecheck gate was already red before the loop started. */
  buildOk: boolean;
  /** Union of failing test identities across all test commands. */
  failingTests: string[];
  results: VerifyBaselineCommandResult[];
  /**
   * True when a test command failed at capture time but produced no parseable
   * test identity. Such a baseline cannot excuse anything — it is rejected on
   * load rather than used to wave through an unreadable failure.
   */
  unattributable: boolean;
  /**
   * Wall-clock ms `captureVerifyFloorBaseline` spent running `commands` above.
   *
   * This is THIS REPOSITORY'S OWN measured cost of one build+test pass, taken
   * before any sprint has changed the tree. It is recorded because the verify
   * stage's watchdog is derived from it (see `computeVerifyBudget` in
   * sprint-runner.ts): a budget that does not scale with the repo it is
   * measuring punishes progress. Measured on run `mttwpmu8ee5b`: 53,133ms.
   *
   * OPTIONAL, and deliberately NOT a version bump: a record written before this
   * field existed is still perfectly valid for everything the baseline is
   * primarily for (the failing-test delta), so rejecting it would be a
   * regression. Absence means "not measured" and a consumer must treat it as
   * unknown — never as zero, which would derive a budget of 0.
   */
  elapsedMs?: number;
}

export type BaselineRejectReason =
  | "not-configured"
  | "missing"
  | "unreadable"
  | "version-mismatch"
  | "different-working-tree"
  | "different-run"
  | "different-branch"
  | "commands-changed"
  | "baseline-unattributable";

/** Which comparison the floor actually applied. Always stated in the failure message. */
export type BaselineRule = "delta" | "absolute";

export type FloorFailureKind =
  | "build-failed"
  | "test-regression"
  | "test-unattributable"
  | "test-absolute-no-baseline"
  | "no-tests-executed"
  /**
   * The gate never got to run the thing it was meant to run — missing launcher,
   * module or script (see `detectGateCouldNotRun`). Distinct from every kind
   * above because it is a statement about the ENVIRONMENT, not about the code:
   * reporting it as a test failure blames the project's tests for a missing
   * dependency and sends the verify-fix loop after code that is fine.
   */
  | "gate-could-not-run"
  | "infra";

/**
 * The subset of `FloorCheck` (verify-floor.ts) this module needs. Declared
 * structurally so the dependency runs one way only: verify-floor imports this
 * module, never the reverse.
 */
export interface FloorCheckLike {
  kind: "build" | "test";
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  noTests?: { kind: string; evidence: string };
  /**
   * Set when the command could not RUN (missing launcher / module / script), as
   * classified by `detectGateCouldNotRun` in verify-floor.runFloorCommand.
   */
  couldNotRun?: { kind: string; evidence: string };
  /** Parsed from the command's FULL output by verify-floor.runFloorCommand. */
  failingTests?: string[];
  formats?: TestRunnerFormat[];
  /**
   * Error identities extracted from this command's FULL output (see
   * `VerifyBaselineCommandResult.errorSet`). Only populated for a build command;
   * a test command's identity is `failingTests` instead.
   */
  errorSet?: string[];
  /**
   * Truncated output tail, used only as a best-effort signal for "does this
   * failure name a file the run changed since baseline" — see
   * `attributeBuildFailure`. Never used as the primary evidence.
   */
  outputTail?: string;
}

/**
 * Who is responsible for a build/typecheck failure that was ALSO red at
 * baseline. A binary `buildAlreadyBroken` used to excuse every such failure as
 * "not this run's doing" — measured false in run `mu54vrme4c87`: the baseline
 * was dirty (an earlier run's leftover breakage), and THIS run downgraded
 * `Microsoft.CodeAnalysis.CSharp` in `Directory.Packages.props`, producing its
 * own NU1107 that the old logic waved through as inherited.
 *
 * - `pre-existing`: the baseline was captured clean, or every error this run
 *   produced was already present at baseline. Safe to excuse.
 * - `run-introduced`: this run's error set contains something new versus the
 *   baseline. Never excuse this — the old bug's exact shape.
 * - `unattributable`: the baseline was dirty and recorded no error signature to
 *   compare against (every baseline written before this field existed falls
 *   here). Cannot be proven pre-existing, so it is NOT excused either.
 */
export type BuildAttribution = "pre-existing" | "run-introduced" | "unattributable";

export interface FloorDelta {
  verdict: "pass" | "fail";
  failureKind?: FloorFailureKind;
  failedCommand?: string;
  /** Failing now, and NOT failing at baseline. This is the run's own damage. */
  newlyFailing: string[];
  /** Failing now AND at baseline. Ignored on purpose; always reported by count. */
  preExisting: string[];
  /** Failing at baseline, passing now. Credit only — never gates anything. */
  fixed: string[];
  /** Set when the build gate failed AND the baseline recorded it already red. */
  buildAlreadyBroken: boolean;
  /**
   * Set only when `buildAlreadyBroken` is true: which of the three honest
   * outcomes applies. See `BuildAttribution` and `attributeBuildFailure`.
   */
  buildAttribution?: BuildAttribution;
  rule: BaselineRule;
  baselineInfo?: { runId: string; capturedAtUtc: string; gitCommit: string | null; failingCount: number };
  /** Why no baseline was applied. Only set when rule === "absolute". */
  rejectReason?: BaselineRejectReason;
  /** False when the baseline's run id was accepted without a run id to check it against. */
  runIdVerified: boolean;
}

export interface LoadedBaseline {
  baseline: VerifyBaseline | null;
  reason?: BaselineRejectReason;
  /** Where the floor looked, for the failure message. Null when nothing was configured. */
  path: string | null;
  /**
   * False when the caller could not name the run asking, so the record's run id
   * was accepted without being checked (the `MUONROI_SPRINT_FLOOR_BASELINE`
   * escape hatch). Surfaced in the message rather than swallowed — an unverified
   * scope is a weaker guarantee and must not read like a verified one.
   */
  runIdVerified?: boolean;
}

export function verifyBaselinePath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, VERIFY_BASELINE_FILENAME);
}

/** Explicit escape hatch: run the floor in delta mode without a wiring change. */
export function resolveBaselinePathFromEnv(): string | null {
  const raw = process.env[VERIFY_BASELINE_ENV];
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

function sameCommandSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((cmd, i) => cmd === b[i]);
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export async function writeVerifyBaseline(filePath: string, baseline: VerifyBaseline): Promise<void> {
  await atomicWriteJSON(filePath, baseline);
}

/**
 * Read a baseline and decide whether it may be applied to THIS run.
 *
 * Returns `{baseline: null, reason}` for every rejection so the caller can state
 * which rule it fell back to and why — a silent rejection would be
 * indistinguishable from a repository that simply has no pre-existing failures.
 */
export async function loadFloorBaseline(opts: {
  baselinePath: string | null;
  cwd: string;
  commands: { build: string[]; test: string[] };
  /** When known, a baseline stamped with a different run id is rejected. */
  runId?: string;
  /** When known, a baseline captured on a different branch is rejected. */
  gitBranch?: string | null;
}): Promise<LoadedBaseline> {
  const { baselinePath } = opts;
  if (!baselinePath) return { baseline: null, reason: "not-configured", path: null, runIdVerified: false };

  let raw: string;
  try {
    raw = await fs.readFile(baselinePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.warn("orchestrator", `[verify-baseline] loadFloorBaseline: no baseline at ${baselinePath}`, {
        operation: "loadFloorBaseline",
      });
      return { baseline: null, reason: "missing", path: baselinePath };
    }
    logger.error(
      "orchestrator",
      `[verify-baseline] loadFloorBaseline: read failed for ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`,
      { operation: "loadFloorBaseline", path: baselinePath, code },
    );
    return { baseline: null, reason: "unreadable", path: baselinePath };
  }

  let parsed: VerifyBaseline;
  try {
    parsed = JSON.parse(raw) as VerifyBaseline;
  } catch (err) {
    logger.error(
      "orchestrator",
      `[verify-baseline] loadFloorBaseline: JSON parse failed for ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`,
      { operation: "loadFloorBaseline", path: baselinePath },
    );
    return { baseline: null, reason: "unreadable", path: baselinePath };
  }

  const reason = baselineRejectReason(parsed, opts);
  if (reason) {
    logger.warn("orchestrator", `[verify-baseline] baseline at ${baselinePath} rejected: ${reason}`, {
      operation: "loadFloorBaseline",
      baselineRunId: parsed?.runId,
      askingRunId: opts.runId,
    });
    return { baseline: null, reason, path: baselinePath };
  }

  return { baseline: parsed, path: baselinePath, runIdVerified: opts.runId !== undefined };
}

function baselineRejectReason(
  b: VerifyBaseline | null,
  opts: { cwd: string; commands: { build: string[]; test: string[] }; runId?: string; gitBranch?: string | null },
): BaselineRejectReason | null {
  if (!b || typeof b !== "object") return "unreadable";
  if (b.version !== VERIFY_BASELINE_VERSION) return "version-mismatch";
  if (!Array.isArray(b.failingTests) || !b.commands) return "unreadable";
  if (typeof b.cwd !== "string" || !samePath(b.cwd, opts.cwd)) return "different-working-tree";
  if (opts.runId && b.runId !== opts.runId) return "different-run";
  if (opts.gitBranch && b.gitBranch && b.gitBranch !== opts.gitBranch) return "different-branch";
  if (!sameCommandSet(b.commands.build ?? [], opts.commands.build)) return "commands-changed";
  if (!sameCommandSet(b.commands.test ?? [], opts.commands.test)) return "commands-changed";
  // A baseline that could not attribute its own failures cannot excuse anyone
  // else's: applying it would silently authorise every failure of that command.
  if (b.unattributable === true) return "baseline-unattributable";
  return null;
}

/**
 * May this check's failure be waved through as inherited?
 *
 * The single predicate behind both "keep running the remaining gates" and "this
 * check does not fail the floor". Having one definition is the point: two copies
 * would drift, and the drift would silently reinstate the absolute gate (or
 * silently open it) depending on which copy won.
 *
 * A failure is tolerated ONLY when all four hold: it is a test command, it ran
 * to completion (no spawn error, no timeout, tests actually executed), its
 * failures are attributable to named tests, and EVERY one of those names was
 * already failing at baseline.
 */
export function isToleratedTestFailure(c: FloorCheckLike, baseline: VerifyBaseline | null): boolean {
  if (c.ok) return true;
  if (c.kind !== "test") return false;
  // A gate that could not RUN produced no evidence about the code, so no
  // baseline can excuse it — even though `failingTests` being empty already
  // stops it below, stating it here keeps the two guards from drifting.
  if (c.spawnError || c.timedOut || c.noTests || c.couldNotRun) return false;
  if (!baseline) return false;
  const ids = c.failingTests ?? [];
  if (ids.length === 0) return false;
  const known = new Set(baseline.failingTests);
  return ids.every((id) => known.has(id));
}

const MAX_DIRTY_FILES = 500;
/** Bound on the normalized tail stored as `failureSignature` — a few screens of output, not a log dump. */
const FAILURE_SIGNATURE_MAX_CHARS = 2000;

const WIN_ABS_PATH_RE = /[A-Za-z]:\\(?:[^\s\\"]+\\)*[^\s\\"]+/g;
const POSIX_ABS_PATH_RE = /(?<![\w.-])\/(?:[\w.-]+\/)+[\w.-]+/g;
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const ELAPSED_RE = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/gi;

/**
 * Strip absolute paths, timestamps and elapsed-time numbers from a command's
 * output so two captures of the SAME failure in DIFFERENT working trees (or at
 * different moments) compare equal. Used for both `failureSignature` and
 * `errorSet` — an un-normalized path or timestamp would make every capture look
 * unique, defeating the whole comparison.
 */
export function normalizeFailureText(text: string): string {
  return text
    .replace(WIN_ABS_PATH_RE, "<path>")
    .replace(POSIX_ABS_PATH_RE, "<path>")
    .replace(TIMESTAMP_RE, "<timestamp>")
    .replace(ELAPSED_RE, "<elapsed>");
}

/** Bounded, normalized tail — the human-readable evidence stored alongside `errorSet`. */
export function buildFailureSignature(rawOutput: string): string {
  const normalized = normalizeFailureText(rawOutput);
  if (normalized.length <= FAILURE_SIGNATURE_MAX_CHARS) return normalized;
  return `…(truncated ${normalized.length - FAILURE_SIGNATURE_MAX_CHARS} chars)…\n${normalized.slice(-FAILURE_SIGNATURE_MAX_CHARS)}`;
}

/**
 * Recognisable build/typecheck error codes: NuGet (`NU####`), C# compiler
 * (`CS####`), TypeScript (`TS####`), MSBuild (`MSB####`). Matches the evidence
 * in run `mu54vrme4c87` (`NU1107`) plus the codes this repo's own gates emit.
 */
const ERROR_CODE_RE = /\berror\s+((?:NU|CS|TS|MSB)\d{3,6})\b/i;

/**
 * The set of error identities in a command's FULL output: one normalized line
 * per recognisable error code, deduplicated. A bare code (`NU1107`) is NOT
 * enough on its own — the SAME code can name a conflict on a DIFFERENT package
 * (the evidence's exact shape), so the whole normalized line is kept as the
 * identity, not just the code.
 */
export function extractErrorSet(rawOutput: string): string[] {
  const normalized = normalizeFailureText(rawOutput);
  const set = new Set<string>();
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line && ERROR_CODE_RE.test(line)) set.add(line);
  }
  return [...set].sort();
}

/** Bound + normalize the dirty-file list captured at baseline time. */
export function boundDirtyFiles(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort().slice(0, MAX_DIRTY_FILES);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Does `text` name any file in `files` by its basename? Best-effort, substring match. */
function mentionsChangedFile(text: string, files: string[] | null): boolean {
  if (!text || !files || files.length === 0) return false;
  const lower = text.toLowerCase();
  return files.some((f) => {
    const base = f.split(/[\\/]/).pop()?.trim();
    return !!base && lower.includes(base.toLowerCase());
  });
}

/**
 * Decide WHO is responsible for a build/typecheck failure that was ALSO red at
 * baseline. Only called when `buildAlreadyBroken` is true (there is a baseline,
 * and it already had `buildOk === false`) — see `BuildAttribution` for what each
 * outcome means and the evidence that motivated a 3-way split instead of the old
 * binary "always pre-existing".
 *
 * `changedFilesSinceBaseline` is precomputed by the caller (verify-floor.ts,
 * which owns all git IO) as the files that differ from the baseline commit,
 * MINUS the files the baseline itself already recorded as dirty — i.e. files
 * this run itself touched, not ones that were already dirty before it started.
 */
export function attributeBuildFailure(
  current: FloorCheckLike,
  baseline: VerifyBaseline,
  changedFilesSinceBaseline: string[] | null,
): BuildAttribution {
  // A baseline captured on a confirmed-clean tree is unambiguously the
  // project's own state — nothing dirty could have laundered a run's damage
  // into it.
  if (baseline.gitDirty === false) return "pre-existing";

  const baselineBuildResult = baseline.results.find((r) => r.kind === "build" && !r.ok);
  const baselineErrorSet = baselineBuildResult?.errorSet;
  const currentErrorSet = current.errorSet ?? [];

  if (Array.isArray(baselineErrorSet)) {
    const known = new Set(baselineErrorSet);
    const hasNewError = currentErrorSet.some((id) => !known.has(id));
    return hasNewError ? "run-introduced" : "pre-existing";
  }

  // No stored signature to compare against — every baseline written before
  // these fields existed lands here, and so does one whose build output never
  // matched a recognisable error code. The code/line rule cannot apply, but a
  // named run-changed file is still decisive.
  return mentionsChangedFile(current.outputTail ?? "", changedFilesSinceBaseline) ? "run-introduced" : "unattributable";
}

/**
 * One line telling the NEXT sprint it must fix a build break the floor could
 * not excuse — `run-introduced` and `unattributable` builds, never
 * `pre-existing` ones (those are genuinely not this run's doing). Returns null
 * for every other failure kind, including a build the run plainly broke
 * (`buildAlreadyBroken === false`) — that case already reaches the next sprint
 * through the ordinary FAIL feedback path and needs no separate carry-over.
 */
export function describeBuildMustFix(delta: FloorDelta): string | null {
  if (delta.failureKind !== "build-failed" || !delta.buildAlreadyBroken) return null;
  if (delta.buildAttribution !== "run-introduced" && delta.buildAttribution !== "unattributable") return null;
  const command = delta.failedCommand ? ` \`${delta.failedCommand}\`` : "";
  const why =
    delta.buildAttribution === "run-introduced"
      ? "this run introduced its own break on top of an already-red baseline"
      : "the baseline was already red and there is not enough evidence to rule this run out";
  return `Build gate${command} is still failing — ${why}. Fix it before the next sprint can be verified.`;
}

/**
 * Decide the floor's verdict from the executed checks and (optionally) a baseline.
 *
 * Ordering is deliberate:
 *
 *  1. Build/typecheck failures ALWAYS fail. A broken build makes every test
 *     result unattributable, so there is no delta to compute. The verdict is the
 *     same either way; only the SENTENCE changes, because "you broke the build"
 *     and "the build was already broken before you started" call for different
 *     human responses.
 *  2. Infrastructure failures (spawn error, timeout) always fail — no evidence.
 *  3. Zero executed tests always fails, baseline or not: absence of evidence is
 *     not evidence of correctness (see `detectNoTestsExecuted`).
 *  4. Only then is the test delta consulted.
 *
 * `changedFilesSinceBaseline` is optional and used only to attribute a build
 * failure that was ALSO red at baseline (see `attributeBuildFailure`); every
 * existing call site that omits it keeps its previous behaviour.
 */
export function computeFloorDelta(
  checks: FloorCheckLike[],
  loaded: LoadedBaseline,
  changedFilesSinceBaseline?: string[] | null,
): FloorDelta {
  const baseline = loaded.baseline;
  const rule: BaselineRule = baseline ? "delta" : "absolute";
  const baselineInfo = baseline
    ? {
        runId: baseline.runId,
        capturedAtUtc: baseline.capturedAtUtc,
        gitCommit: baseline.gitCommit,
        failingCount: baseline.failingTests.length,
      }
    : undefined;

  const base = {
    newlyFailing: [] as string[],
    preExisting: [] as string[],
    fixed: [] as string[],
    buildAlreadyBroken: false,
    rule,
    baselineInfo,
    rejectReason: baseline ? undefined : loaded.reason,
    runIdVerified: loaded.runIdVerified === true,
  };

  const baselineFailing = new Set(baseline?.failingTests ?? []);
  const currentFailing = new Set<string>();
  for (const c of checks) {
    if (c.kind !== "test") continue;
    for (const id of c.failingTests ?? []) currentFailing.add(id);
  }

  const preExisting = [...currentFailing].filter((id) => baselineFailing.has(id)).sort();
  const newlyFailing = [...currentFailing].filter((id) => !baselineFailing.has(id)).sort();
  const fixed = [...baselineFailing].filter((id) => !currentFailing.has(id)).sort();

  for (const c of checks) {
    if (isToleratedTestFailure(c, baseline)) continue;

    if (c.spawnError || c.timedOut) {
      return { ...base, verdict: "fail", failureKind: "infra", failedCommand: c.command, preExisting, fixed };
    }

    // BEFORE the build and test branches, and for both tiers. A gate whose
    // launcher, module or script is absent said nothing about the code: naming
    // it `build-failed` would accuse this run of breaking a build it never
    // compiled, and naming it a test failure would accuse the project's tests of
    // a missing dependency. Still `verdict: "fail"` — an un-runnable gate has no
    // evidence, so it must never open the floor — only the CAUSE changes.
    if (c.couldNotRun) {
      return {
        ...base,
        verdict: "fail",
        failureKind: "gate-could-not-run",
        failedCommand: c.command,
        preExisting,
        fixed,
      };
    }

    if (c.kind === "build") {
      const buildAlreadyBroken = baseline ? baseline.buildOk === false : false;
      return {
        ...base,
        verdict: "fail",
        failureKind: "build-failed",
        failedCommand: c.command,
        buildAlreadyBroken,
        buildAttribution:
          buildAlreadyBroken && baseline
            ? attributeBuildFailure(c, baseline, changedFilesSinceBaseline ?? null)
            : undefined,
        preExisting,
        fixed,
      };
    }

    if (c.noTests) {
      return {
        ...base,
        verdict: "fail",
        failureKind: "no-tests-executed",
        failedCommand: c.command,
        preExisting,
        fixed,
      };
    }

    // A failing test command with no baseline: the absolute rule applies.
    if (!baseline) {
      return {
        ...base,
        verdict: "fail",
        failureKind: "test-absolute-no-baseline",
        failedCommand: c.command,
        newlyFailing: (c.failingTests ?? []).slice().sort(),
        preExisting,
        fixed,
      };
    }

    // A failing test command whose failures could not be attributed to named
    // tests cannot be excused by ANY baseline — we would be guessing.
    if ((c.failingTests ?? []).length === 0) {
      return {
        ...base,
        verdict: "fail",
        failureKind: "test-unattributable",
        failedCommand: c.command,
        preExisting,
        fixed,
      };
    }

    // isToleratedTestFailure already excluded the inherited-only case, so any
    // attributable test failure reaching here contains at least one new name.
    return {
      ...base,
      verdict: "fail",
      failureKind: "test-regression",
      failedCommand: c.command,
      newlyFailing,
      preExisting,
      fixed,
    };
  }

  return { ...base, verdict: "pass", newlyFailing, preExisting, fixed };
}

/** One line naming the comparison that was applied, and (when absolute) why. */
export function describeBaselineRule(delta: FloorDelta): string {
  if (delta.rule === "delta" && delta.baselineInfo) {
    const b = delta.baselineInfo;
    const commit = b.gitCommit ? b.gitCommit.slice(0, 12) : "unknown-commit";
    const caveat = delta.runIdVerified
      ? ""
      : ` NOTE: the caller named no run, so that run id was NOT checked against this one — confirm the baseline belongs to this run.`;
    return `Rule applied: DELTA — compared against the baseline captured for run ${b.runId} at ${b.capturedAtUtc} (commit ${commit}, ${b.failingCount} test(s) already failing).${caveat}`;
  }
  const why = ABSOLUTE_REASON[delta.rejectReason ?? "not-configured"];
  return `Rule applied: ABSOLUTE (fail-closed) — ${why} With no baseline the floor cannot tell a failure this run caused from one it inherited, and a gate whose evidence is missing must not open. Capture a baseline before the loop starts changing things, or point ${VERIFY_BASELINE_ENV} at one.`;
}

const ABSOLUTE_REASON: Record<BaselineRejectReason, string> = {
  "not-configured": "no baseline was configured for this run.",
  missing: "the configured baseline file does not exist.",
  unreadable: "the baseline file could not be read or parsed.",
  "version-mismatch": "the baseline was written by an older, incompatible version of this gate.",
  "different-working-tree": "the baseline was captured in a different working tree.",
  "different-run": "the baseline belongs to a different /ideal run.",
  "different-branch": "the baseline was captured on a different git branch.",
  "commands-changed": "the project's build/test commands changed since the baseline was captured.",
  "baseline-unattributable": "the baseline itself recorded a test failure it could not attribute to a named test.",
};
