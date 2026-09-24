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
 *
 * ## Where the baseline lives, and why it moved out of the project
 *
 * `verify-floor.ts` opens by stating the floor's premise: the gate commands are
 * re-derived from disk because "disk-derived commands are unspoofable from
 * inside the turn". The baseline was NOT held to that standard. It lived at
 * `<project>/.muonroi-flow/runs/<runId>/verify-baseline.json` — inside the very
 * working tree the turn edits — and that is the artifact deciding whether a
 * failure is blamed on this run or excused as inherited.
 *
 * MEASURED, run `muc2joffe506` in `D:\sources\CompanyLibs\qa-platform`. During
 * sprint 2's implementation stage a sub-agent authored a project script
 * (`verify.mjs`) whose report destination was
 *
 *     path.join(process.cwd(), ".muonroi-flow", "runs", "muc2joffe506", "verify-baseline.json")
 *
 * — this exact path, with the live run's id hardcoded — and COMMITTED it to the
 * project (`git_commit`, 2026-09-23T14:24:12Z, "feat(ci): add verify script").
 * From then on every invocation of the project's own verify command overwrote
 * the baseline with a 176-byte report of its own. The write at
 * `2026-09-24T06:53:58.576Z` landed inside sprint 2's verification window, and
 * `sprints/2-verify.md` recorded the floor losing its baseline for the rest of
 * the run.
 *
 * Note what limited the damage: LUCK. The foreign file had the wrong SHAPE. It
 * had the right `runId` and the right `version`. A file with the right shape and
 * a long fabricated `failingTests` list would have been ACCEPTED, and every real
 * regression in the run excused as pre-existing. That is a gate-defeat path.
 *
 * So the authority moved OUT of the project tree, to
 * `~/.muonroi-cli/floor-baselines/<runId>.json` (`floorBaselineWitnessPath`).
 * The in-tree file is still written, because a baseline a human can open next to
 * the run's other artifacts is genuinely useful — it is now a COPY, and
 * `loadFloorBaseline` cross-checks it against the witness so that a project
 * script overwriting it is REPORTED rather than obeyed.
 *
 * ## What this is and is not
 *
 * This is tamper DETECTION with the authority held somewhere a project's own
 * tooling does not compute, NOT authentication. A turn with unrestricted shell
 * access can read and write `~/.muonroi-cli` as easily as the project tree, so a
 * keyed hash would be theatre: any key the loop can read to verify, the turn can
 * read to forge. What the move does buy is decisive against the failure that
 * actually happens — a project-local script computing a path from
 * `process.cwd()` can never reach the witness — and every disagreement between
 * the two copies is surfaced with a reason that names it.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
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
  /**
   * The bytes read and parsed as JSON perfectly well, and then turned out not to
   * be a baseline record at all. Split out of `unreadable` because collapsing
   * the two is what made the measured incident unreadable to its user: the
   * foreign `verify.mjs` report parsed fine and was rejected on SHAPE, while the
   * sentence blamed an IO/parse failure that never happened. The distinction is
   * the difference between "your disk hiccuped" and "something else is writing
   * to this path".
   */
  | "shape-mismatch"
  | "version-mismatch"
  | "different-working-tree"
  | "different-run"
  | "different-branch"
  | "commands-changed"
  | "baseline-unattributable";

/** Which comparison the floor actually applied. Always stated in the failure message. */
export type BaselineRule = "delta" | "absolute";

/**
 * WHICH copy of the baseline the verdict was computed from. Stated in the
 * message, because the three carry different guarantees:
 *
 * - `witness`: the authoritative copy outside the project tree. The only source
 *   a project-local script cannot compute a path to.
 * - `in-tree`: the copy inside the working tree the run itself edits. Trusted
 *   only when no witness exists (a record from before the witness existed, or a
 *   run whose witness write failed). A weaker guarantee, and it must not be
 *   reported as if it were the strong one.
 * - `env`: the operator pointed `MUONROI_SPRINT_FLOOR_BASELINE` at a file. An
 *   explicit human override outranks everything, including the witness.
 */
export type BaselineSource = "witness" | "in-tree" | "env";

/**
 * The in-tree copy disagrees with the authoritative witness. The verdict is
 * unaffected (the witness decides), but the user has a script or an agent
 * writing to the gate's path and cannot fix what they are not told about.
 *
 * - `foreign`: the file at the baseline path is not a baseline record at all —
 *   the measured incident's exact shape.
 * - `clobbered`: it IS a baseline record, and it is not the one this gate wrote.
 * - `vanished`: the gate wrote it and it is no longer there.
 */
export interface BaselineTamper {
  kind: "foreign" | "clobbered" | "vanished";
  /** The in-tree path that was overwritten, so the user can go and look at it. */
  path: string;
  /** What specifically differed, in one clause. */
  detail: string;
}

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
  /** The specifics behind `rejectReason` — which fields were missing, which path. */
  rejectDetail?: string;
  /** Which copy the verdict came from. Only set when rule === "delta". */
  baselineSource?: BaselineSource;
  /** Set when the in-tree copy disagreed with the witness. Never changes the verdict. */
  tamper?: BaselineTamper;
  /** False when the baseline's run id was accepted without a run id to check it against. */
  runIdVerified: boolean;
}

export interface LoadedBaseline {
  baseline: VerifyBaseline | null;
  reason?: BaselineRejectReason;
  /** The specifics behind `reason` — which fields were missing, which path. */
  reasonDetail?: string;
  /** Where the floor looked, for the failure message. Null when nothing was configured. */
  path: string | null;
  /** Which copy the returned baseline came from. Only set when one was returned. */
  source?: BaselineSource;
  /** Set when the in-tree copy disagreed with the witness. Never changes the verdict. */
  tamper?: BaselineTamper;
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

/**
 * A run id is about to become a path segment. Anything that is not a plain id
 * could escape the witness directory, so an unexpected shape yields NO witness
 * rather than a guessed-at path — the floor then runs in-tree-only and says so,
 * which is a weaker guarantee but never a wrong file.
 */
function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(runId) && runId !== "." && runId !== "..";
}

/**
 * The AUTHORITATIVE copy's path: outside every project tree, keyed by run id.
 *
 * This is the whole mechanism. The measured clobber came from a project script
 * computing `path.join(process.cwd(), ".muonroi-flow", "runs", <runId>, ...)`;
 * no such script can arrive here, because nothing about this path derives from
 * the project being worked on. Returns null for a run id that cannot safely be
 * a path segment (see `isSafeRunId`).
 *
 * Keyed by run id ALONE, not by run id + working tree. Run ids are generated
 * unique per run, so two trees holding the same id means one was REUSED — and
 * `baselineRejectReason`'s `different-working-tree` check already catches that
 * loudly. Folding the tree into the filename would only make the record harder
 * for a human to find, in exchange for silencing a signal worth hearing.
 */
export function floorBaselineWitnessPath(runId: string, homeDir: string = os.homedir()): string | null {
  if (!isSafeRunId(runId)) {
    logger.warn(
      "orchestrator",
      `[verify-baseline] run id ${JSON.stringify(runId)} cannot be a path segment — no out-of-tree baseline witness for this run`,
      { operation: "floorBaselineWitnessPath", runId },
    );
    return null;
  }
  const override = process.env[VERIFY_BASELINE_WITNESS_DIR_ENV];
  const dir =
    override && override.trim().length > 0 ? override.trim() : path.join(homeDir, ".muonroi-cli", "floor-baselines");
  return path.join(dir, `${runId}${path.extname(VERIFY_BASELINE_FILENAME)}`);
}

/**
 * Relocate the witness DIRECTORY. For a host where `~` is not writable, and for
 * the test suite, which must never write into the developer's real CLI home (it
 * did, once: four stray `floor-baselines/*.json` records from a single run, one
 * of which then leaked a previous test's baseline into the next test's verdict).
 */
export const VERIFY_BASELINE_WITNESS_DIR_ENV = "MUONROI_FLOOR_BASELINE_DIR";

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

/** One read attempt: the bytes parsed, or the reason they were not usable. */
type ReadAttempt =
  | { ok: true; parsed: VerifyBaseline }
  | { ok: false; reason: "missing" | "unreadable"; detail?: string };

async function readBaselineFile(filePath: string): Promise<ReadAttempt> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.warn("orchestrator", `[verify-baseline] readBaselineFile: no baseline at ${filePath}`, {
        operation: "readBaselineFile",
      });
      return { ok: false, reason: "missing" };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error("orchestrator", `[verify-baseline] readBaselineFile: read failed for ${filePath}: ${message}`, {
      operation: "readBaselineFile",
      path: filePath,
      code,
    });
    return { ok: false, reason: "unreadable", detail: `${code ?? "read error"}: ${message}` };
  }

  try {
    return { ok: true, parsed: JSON.parse(raw) as VerifyBaseline };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("orchestrator", `[verify-baseline] readBaselineFile: JSON parse failed for ${filePath}: ${message}`, {
      operation: "readBaselineFile",
      path: filePath,
    });
    return { ok: false, reason: "unreadable", detail: `not JSON — ${message}` };
  }
}

/**
 * Read a baseline and decide whether it may be applied to THIS run.
 *
 * Returns `{baseline: null, reason}` for every rejection so the caller can state
 * which rule it fell back to and why — a silent rejection would be
 * indistinguishable from a repository that simply has no pre-existing failures.
 *
 * ## Precedence, and why it goes this way
 *
 *  1. `MUONROI_SPRINT_FLOOR_BASELINE` — an operator pointing the gate at a file
 *     is an explicit instruction and outranks everything. It is also the remedy
 *     the ABSOLUTE message tells users to reach for, so it has to actually work
 *     from every call site, including the ones that pass a `baselinePath`.
 *  2. The out-of-tree witness — the authoritative copy, when one exists.
 *  3. The in-tree copy — trusted only when there is no witness (a record from
 *     before the witness existed, or a run whose witness write failed).
 *
 * When BOTH 2 and 3 exist, the witness decides the verdict and the in-tree copy
 * is CROSS-CHECKED against it. A disagreement is reported via `tamper` and never
 * changes the verdict: the witness is strictly better evidence (written at run
 * start, at a path the project's own tooling does not compute), and falling back
 * to ABSOLUTE on a clobber would reproduce the very damage the incident caused.
 */
export async function loadFloorBaseline(opts: {
  /** The in-tree copy — `<flowDir>/runs/<runId>/verify-baseline.json`. */
  baselinePath: string | null;
  /**
   * The out-of-tree authoritative copy. Pass `null` to run in-tree-only (tests
   * that exercise the legacy path, and callers with no run id).
   */
  witnessPath?: string | null;
  cwd: string;
  commands: { build: string[]; test: string[] };
  /** When known, a baseline stamped with a different run id is rejected. */
  runId?: string;
  /** When known, a baseline captured on a different branch is rejected. */
  gitBranch?: string | null;
}): Promise<LoadedBaseline> {
  const envPath = resolveBaselinePathFromEnv();
  const witnessPath = opts.witnessPath ?? null;
  const inTreePath = opts.baselinePath;

  // 1 — the explicit operator override.
  if (envPath) {
    return await applyCandidate(envPath, "env", opts);
  }

  // 2 — the authoritative witness, cross-checked against the readable copy.
  if (witnessPath) {
    const witness = await readBaselineFile(witnessPath);
    if (witness.ok) {
      const loaded = await applyCandidate(witnessPath, "witness", opts, witness);
      const tamper = inTreePath ? await detectInTreeTamper(inTreePath, witness.parsed) : undefined;
      if (tamper) {
        logger.error(
          "orchestrator",
          `[verify-baseline] the in-tree baseline copy at ${inTreePath} was not written by this gate (${tamper.kind}: ${tamper.detail}) — the verdict used the out-of-tree witness at ${witnessPath}`,
          { operation: "loadFloorBaseline", runId: opts.runId, tamper: tamper.kind },
        );
      }
      return tamper ? { ...loaded, tamper } : loaded;
    }
    // No witness for this run. Fall through to the in-tree copy, which is the
    // only source older runs ever had.
  }

  // 3 — the in-tree copy, on its own.
  if (!inTreePath) return { baseline: null, reason: "not-configured", path: null, runIdVerified: false };
  return await applyCandidate(inTreePath, "in-tree", opts);
}

async function applyCandidate(
  filePath: string,
  source: BaselineSource,
  opts: { cwd: string; commands: { build: string[]; test: string[] }; runId?: string; gitBranch?: string | null },
  prefetched?: { ok: true; parsed: VerifyBaseline },
): Promise<LoadedBaseline> {
  const attempt = prefetched ?? (await readBaselineFile(filePath));
  if (!attempt.ok) {
    return { baseline: null, reason: attempt.reason, reasonDetail: attempt.detail, path: filePath };
  }

  const verdict = baselineRejectReason(attempt.parsed, opts);
  if (verdict) {
    logger.warn("orchestrator", `[verify-baseline] baseline at ${filePath} rejected: ${verdict.reason}`, {
      operation: "loadFloorBaseline",
      baselineRunId: attempt.parsed?.runId,
      askingRunId: opts.runId,
      source,
      detail: verdict.detail,
    });
    return { baseline: null, reason: verdict.reason, reasonDetail: verdict.detail, path: filePath };
  }

  return { baseline: attempt.parsed, path: filePath, source, runIdVerified: opts.runId !== undefined };
}

/**
 * Is the readable in-tree copy still the record this gate wrote?
 *
 * Compared structurally against the witness rather than by embedded digest: a
 * digest inside the file would be recomputable by whatever overwrote it, so it
 * would prove nothing. The witness is the reference precisely because it is
 * somewhere a project-local script does not look.
 */
async function detectInTreeTamper(inTreePath: string, witness: VerifyBaseline): Promise<BaselineTamper | undefined> {
  const attempt = await readBaselineFile(inTreePath);
  if (!attempt.ok) {
    if (attempt.reason === "missing") {
      return { kind: "vanished", path: inTreePath, detail: "the gate wrote it and it is no longer there" };
    }
    return {
      kind: "foreign",
      path: inTreePath,
      detail: attempt.detail ?? "the bytes there could not be read or parsed as JSON",
    };
  }

  const shape = describeShapeMismatch(attempt.parsed);
  if (shape) {
    return { kind: "foreign", path: inTreePath, detail: `it is not a baseline record — ${shape}` };
  }

  if (canonicalDigest(attempt.parsed) === canonicalDigest(witness)) return undefined;
  const theirs = Array.isArray(attempt.parsed.failingTests) ? attempt.parsed.failingTests.length : "?";
  // Name the difference a reader can act on. The failure COUNT is the one that
  // matters (it is what authorises failures); the capture time is only mentioned
  // when it actually differs, or it reads as the same value printed twice.
  const clauses = [`it claims ${theirs} pre-existing failure(s) against the witness's ${witness.failingTests.length}`];
  if (attempt.parsed.capturedAtUtc !== witness.capturedAtUtc) {
    clauses.push(
      `and is stamped ${String(attempt.parsed.capturedAtUtc)} against the witness's ${witness.capturedAtUtc}`,
    );
  }
  return {
    kind: "clobbered",
    path: inTreePath,
    detail: `it is a baseline record, but not the one this gate captured (${clauses.join(", ")})`,
  };
}

/** Key order must not change the answer, so the record is canonicalised first. */
function canonicalDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return sha256Hex(JSON.stringify(canonical(value)));
}

/**
 * The fields without which a record cannot be a baseline. Absence means
 * something other than this gate wrote the file — which is a different problem
 * from a corrupt read, and must be reported as one.
 */
function describeShapeMismatch(b: VerifyBaseline | null): string | null {
  if (!b || typeof b !== "object") return "it is not a JSON object";
  const missing: string[] = [];
  if (typeof b.runId !== "string") missing.push("runId");
  if (typeof b.capturedAtUtc !== "string") missing.push("capturedAtUtc");
  if (typeof b.cwd !== "string") missing.push("cwd");
  if (!b.commands || typeof b.commands !== "object") missing.push("commands");
  if (typeof b.buildOk !== "boolean") missing.push("buildOk");
  if (!Array.isArray(b.failingTests)) missing.push("failingTests");
  if (!Array.isArray(b.results)) missing.push("results");
  if (missing.length === 0) return null;
  return `missing or wrong-typed field(s): ${missing.join(", ")}`;
}

function baselineRejectReason(
  b: VerifyBaseline | null,
  opts: { cwd: string; commands: { build: string[]; test: string[] }; runId?: string; gitBranch?: string | null },
): { reason: BaselineRejectReason; detail?: string } | null {
  if (!b || typeof b !== "object") return { reason: "unreadable", detail: "the JSON was not an object" };
  const shape = describeShapeMismatch(b);
  // Version first, but only when the record DECLARES one: a v2 record that
  // renamed fields must report `version-mismatch`, not a shape complaint about
  // a schema this code is not meant to understand. A file with no version at
  // all is not a baseline of any vintage, so it falls to the shape reason.
  if (typeof b.version === "number" && b.version !== VERIFY_BASELINE_VERSION) {
    return {
      reason: "version-mismatch",
      detail: `record version ${b.version}, this gate speaks ${VERIFY_BASELINE_VERSION}`,
    };
  }
  if (shape) return { reason: "shape-mismatch", detail: shape };
  if (b.version !== VERIFY_BASELINE_VERSION) {
    return {
      reason: "version-mismatch",
      detail: `record version ${String(b.version)}, this gate speaks ${VERIFY_BASELINE_VERSION}`,
    };
  }
  if (!samePath(b.cwd, opts.cwd)) {
    return { reason: "different-working-tree", detail: `captured in ${b.cwd}, running in ${opts.cwd}` };
  }
  if (opts.runId && b.runId !== opts.runId) {
    return { reason: "different-run", detail: `record belongs to run ${b.runId}, this is run ${opts.runId}` };
  }
  if (opts.gitBranch && b.gitBranch && b.gitBranch !== opts.gitBranch) {
    return { reason: "different-branch", detail: `captured on ${b.gitBranch}, running on ${opts.gitBranch}` };
  }
  if (!sameCommandSet(b.commands.build ?? [], opts.commands.build)) {
    return { reason: "commands-changed", detail: "the build/typecheck command set differs from the capture" };
  }
  if (!sameCommandSet(b.commands.test ?? [], opts.commands.test)) {
    return { reason: "commands-changed", detail: "the test command set differs from the capture" };
  }
  // A baseline that could not attribute its own failures cannot excuse anyone
  // else's: applying it would silently authorise every failure of that command.
  if (b.unattributable === true) return { reason: "baseline-unattributable" };
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
    rejectDetail: baseline ? undefined : loaded.reasonDetail,
    baselineSource: baseline ? loaded.source : undefined,
    // Reported whether the verdict passed or failed: a clobbered readable copy
    // is the user's problem to fix either way, and on a PASS it is the only
    // place they would ever learn about it.
    tamper: loaded.tamper,
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
    const provenance = delta.baselineSource ? ` ${SOURCE_NOTE[delta.baselineSource]}` : "";
    return `Rule applied: DELTA — compared against the baseline captured for run ${b.runId} at ${b.capturedAtUtc} (commit ${commit}, ${b.failingCount} test(s) already failing).${provenance}${caveat}${describeTamper(delta)}`;
  }
  const why = ABSOLUTE_REASON[delta.rejectReason ?? "not-configured"];
  const detail = delta.rejectDetail ? ` (${delta.rejectDetail})` : "";
  return `Rule applied: ABSOLUTE (fail-closed) — ${why}${detail} With no baseline the floor cannot tell a failure this run caused from one it inherited, and a gate whose evidence is missing must not open. Capture a baseline before the loop starts changing things, or point ${VERIFY_BASELINE_ENV} at one.${describeTamper(delta)}`;
}

/**
 * The sentence through which a user learns their baseline was overwritten.
 *
 * Appended on PASS as well as FAIL: the witness means a clobber no longer
 * changes the verdict, so a PASS is now the likeliest place this shows up, and a
 * silent PASS would leave the script doing it running forever.
 */
function describeTamper(delta: FloorDelta): string {
  const t = delta.tamper;
  if (!t) return "";
  return (
    ` WARNING: the readable copy of this baseline at ${t.path} was NOT written by this gate — ${t.detail}.` +
    ` The verdict above used the authoritative copy outside the working tree, so nothing was excused on its word;` +
    ` but something in this project writes to that path (a verification script computing it from the project root is the measured cause), and it will keep doing so until you find it.`
  );
}

const SOURCE_NOTE: Record<BaselineSource, string> = {
  witness: "Source: the authoritative copy outside the working tree.",
  "in-tree":
    "Source: the copy inside the working tree the run itself edits, with no out-of-tree witness to check it against — a weaker guarantee, since anything the run does could have written it.",
  env: `Source: the file ${VERIFY_BASELINE_ENV} points at, which overrides the gate's own copy.`,
};

const ABSOLUTE_REASON: Record<BaselineRejectReason, string> = {
  "not-configured": "no baseline was configured for this run.",
  missing: "the configured baseline file does not exist.",
  unreadable: "the baseline file could not be read or parsed.",
  "shape-mismatch":
    "the file at the baseline path read and parsed perfectly well and is NOT a baseline record — so it was not written by this gate, and something else in this project is writing there.",
  "version-mismatch": "the baseline was written by an older, incompatible version of this gate.",
  "different-working-tree": "the baseline was captured in a different working tree.",
  "different-run": "the baseline belongs to a different /ideal run.",
  "different-branch": "the baseline was captured on a different git branch.",
  "commands-changed": "the project's build/test commands changed since the baseline was captured.",
  "baseline-unattributable": "the baseline itself recorded a test failure it could not attribute to a named test.",
};
