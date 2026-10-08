/**
 * src/product-loop/project-registration-check.ts
 *
 * S6 — a deterministic check that a newly created project manifest is actually
 * REGISTERED in its ecosystem's workspace/solution index.
 *
 * ## The bug this closes
 *
 * Live run `mu54vrme4c87` created a new .NET analyzer project and its test
 * project, but never added either to the repo's solution file. The solution
 * carried 108 projects and zero matches for the two new ones. `dotnet test
 * <sln>` therefore never ran their tests, and both sprints ended
 * `engineering_floor: zero_coverage` — the floor (verify-floor.ts) and
 * `layout-convention.ts`'s "Layout convention" block both already reach the
 * planner, and sprint 1's own plan even listed "register in the solution" as
 * task 1, but prompt text alone did not make it happen.
 *
 * `layout-convention.ts` is REPORT ONLY by design (see that module's doc
 * comment) — it states the convention with counts as evidence, but nothing
 * there enforces it. This module is the enforcement half: given the files a
 * sprint added since the run's baseline, it asks one falsifiable question per
 * ecosystem — "is every new project manifest referenced by its solution/
 * workspace index?" — and reports a `status` a caller can act on.
 *
 * ## What this module does NOT do
 *
 * It never rewrites the solution file, never runs `dotnet sln add`, and never
 * changes the deterministic floor's own build/test verdict (`verify-floor.ts`).
 * It is a SEPARATE, additive signal: the caller (`sprint-runner.ts`) folds a
 * violation into the verify-fix loop's must-fix text and trigger, the same way
 * `describeBuildMustFix` (`verify-baseline.ts`) already does for a run-
 * introduced build break — never into done-gate math or the floor's pass/fail.
 *
 * ## Ecosystem coverage
 *
 * Only .NET (`.sln` / `.slnx`, referencing `.csproj` / `.fsproj` / `.vbproj`)
 * is implemented for real. Every other ecosystem with a project manifest
 * (`Cargo.toml`, `go.mod`, `package.json`, `pyproject.toml`, `pom.xml`,
 * `build.gradle`) reports `status: "unsupported"` and logs at debug level —
 * deliberately not implemented here (Cargo workspace members, `go.work`,
 * pnpm/npm workspaces all have their own membership syntax that deserves its
 * own slice, not a rushed guess).
 *
 * ## Never guess
 *
 * When more than one `.sln`/`.slnx` could plausibly own a new project (no
 * `LayoutConvention.solutionFile`, and more than one solution file sits in an
 * ancestor directory of the new project), the result is `"ambiguous"`, never a
 * silent pick. A project that lives outside every candidate solution's own
 * directory tree is treated as intentionally standalone and is never flagged.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createGitSpawnBudget, type GitSpawnBudget, runGitSpawn } from "../utils/git-spawn.js";
import { logger } from "../utils/logger.js";
import {
  BUILD_OUTPUT_DIRS,
  isProjectManifest,
  isSolutionManifest,
  type ManifestSpec,
  matchManifest,
} from "./language-registry.js";
import { type LayoutConvention, scanLayoutConvention } from "./layout-convention.js";
import type { VerifyBaseline } from "./verify-baseline.js";

/** Depth/entry caps for the repo-wide solution-file walk — bounded, not exhaustive. */
const MAX_WALK_DEPTH = 8;
const MAX_WALK_ENTRIES = 40_000;

/** Bound on how many new manifests / solution candidates / unregistered entries are ever reported. */
const MAX_NEW_MANIFESTS = 200;
const MAX_UNREGISTERED = 100;
const MAX_SOLUTION_FILES = 200;

export type ProjectRegistrationStatus = "ok" | "violations" | "unsupported" | "ambiguous" | "error";

export interface UnregisteredManifest {
  /** Repo-relative POSIX path of the new project manifest. */
  manifest: string;
  /** Human-readable reason — always names what happened, never a bare code. */
  reason: string;
  /** Set only for a genuine, single-candidate violation — the solution this manifest belongs in. */
  solutionFile?: string;
}

export interface ProjectRegistrationEcosystemResult {
  /** Display language, matching `LanguageSpec.lang` / `ManifestSpec.lang` (e.g. "C#"). */
  ecosystem: string;
  /** The solution/workspace file this ecosystem's new manifests were checked against, when unambiguous. */
  solutionFile: string | null;
  unregistered: UnregisteredManifest[];
  status: ProjectRegistrationStatus;
}

export type AddedFilesSource = "git-diff+status" | "git-status-fallback";

export interface ProjectRegistrationCheckResult {
  ecosystems: ProjectRegistrationEcosystemResult[];
  addedFilesSource: AddedFilesSource;
  addedFilesCount: number;
  /** Set when the added-files computation degraded (e.g. no baseline, diff unavailable). */
  note?: string;
  /** Set only when the check could not run at all — never treated as a violation. */
  error?: string;
}

// ─── git plumbing ──────────────────────────────────────────────────────────
// D7: the actual spawn + retry + logging now lives in the shared
// `utils/git-spawn.ts` (`runGitSpawn`), which this module and
// `verify-floor.ts` both import — it lives in `src/utils/`, not
// `verify-floor.ts`, so this module still never depends on `verify-floor.ts`
// (verify-floor already depends on `verify-baseline.ts`; this module must
// not create a cycle back into it). This wrapper only maps the shared
// result back to this module's own `{ok:true,stdout}|{ok:false,error}`
// contract so every existing caller in this file is unaffected. `budget` is
// optional and forwarded as-is: `computeAddedFilesSinceBaseline` makes two
// sequential calls sharing one `GitSpawnBudget` so that whole computation is
// capped at one total elapsed budget, not two.

function runGit(
  args: string[],
  cwd: string,
  op: string,
  budget?: GitSpawnBudget,
): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = runGitSpawn(args, cwd, op, "project-registration-check", budget);
  return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, error: result.error ?? "git spawn failed" };
}

/** Parse `git status --porcelain` lines into repo-relative paths (rename keeps the NEW side). */
function parsePorcelainPaths(statusOutput: string): string[] {
  return statusOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(2).trim();
      const arrow = rest.indexOf(" -> ");
      const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
      return p.replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
    })
    .filter(Boolean);
}

/**
 * Parse `git diff --name-status -M -C <commit>` output, keeping every entry
 * that is NEW at its listed path: `A` (added), and `R###`/`C###` (rename/copy
 * — the destination path has no history under it, so an already-existing
 * project moved or copied there is exactly as invisible to a stale solution
 * reference as a brand-new file would be). `-M -C` on the caller's command is
 * load-bearing: without it git may not detect renames at all depending on the
 * user's `diff.renames` config, and this parser would then see a plain
 * delete+add pair instead — still caught (the add half), but only by luck.
 *
 * `R`/`C` lines carry TWO tab-separated paths (`R100\told\tnew`); the new
 * path is always the LAST field, whatever the similarity score digits are.
 */
function parseAddedFromDiff(diffOutput: string): string[] {
  const added: string[] = [];
  for (const rawLine of diffOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = (fields[0] ?? "").trim();
    const isAdded = status === "A";
    const isRenameOrCopy = /^[RC]\d*$/.test(status);
    if (!isAdded && !isRenameOrCopy) continue;
    // Added: fields = [status, path]. Rename/copy: fields = [status, old, new].
    const filePath = (fields[fields.length - 1] ?? "").trim();
    if (filePath) added.push(filePath.replace(/\\/g, "/"));
  }
  return added;
}

export interface AddedFilesResult {
  files: string[];
  source: AddedFilesSource;
  note?: string;
  error?: string;
}

/** True when any path segment names a build-output/ignored directory (reuses `BUILD_OUTPUT_DIRS` — no second list). */
function isUnderBuildOutputDir(relPosixPath: string): boolean {
  return relPosixPath.split("/").some((seg) => BUILD_OUTPUT_DIRS.has(seg));
}

/**
 * Project manifests that came into existence SINCE the baseline was captured
 * — the set a new project must appear in to be considered "added this run".
 *
 * Two sources are combined: `git status --porcelain` (catches an untracked or
 * staged-but-uncommitted new file — the common case for a project a sprint just
 * created) and, when the baseline recorded a `gitCommit`, `git diff --name-
 * status <commit>` (catches a new file this run went on to COMMIT, which would
 * otherwise have dropped out of `git status` entirely). Either set is reduced by
 * `baseline.dirtyFiles` — paths that were ALREADY dirty at baseline time, so
 * they predate this run and are not "added since".
 *
 * A baseline with no `gitCommit` (or no baseline at all) falls back to the
 * `git status` source alone and says so via `note` — see the module doc.
 *
 * The build-output-directory filter and the project-manifest filter are BOTH
 * applied BEFORE the `MAX_NEW_MANIFESTS` bound below, deliberately: a flood of
 * thousands of non-manifest files (a large, un-ignored `bin/` tree is a real
 * example — `bin` is NOT in `BUILD_OUTPUT_DIRS`, see language-registry.ts) must
 * never be able to push a genuine new project manifest past the slice cutoff
 * and make it invisible to this check. Filtering first means the bound only
 * ever discards EXCESS manifests, never a real one buried under noise.
 *
 * D7 (acceptance-review fix): the up-to-2 sequential git calls below share
 * ONE `GitSpawnBudget` (`createGitSpawnBudget()`, default 60s total) so the
 * whole computation is capped at one total elapsed budget, not two.
 */
export async function computeAddedFilesSinceBaseline(
  cwd: string,
  baseline: VerifyBaseline | null,
): Promise<AddedFilesResult> {
  const budget = createGitSpawnBudget();
  // `-uall` is load-bearing: plain `--porcelain` reports an entirely-untracked
  // DIRECTORY as one line ("?? src/"), never the file inside it — which would
  // make a brand-new project manifest invisible to this exact check. This
  // repository's own `parseDirtyPaths` (verify-floor.ts) does not need `-uall`
  // because it only cares THAT the tree is dirty, never which files inside an
  // untracked directory moved.
  const statusRes = runGit(["status", "--porcelain", "-uall"], cwd, "computeAddedFilesSinceBaseline", budget);
  if (!statusRes.ok) {
    return { files: [], source: "git-status-fallback", error: statusRes.error };
  }
  const statusPaths = new Set(parsePorcelainPaths(statusRes.stdout));

  let note: string | undefined;
  if (!baseline) {
    note = "no baseline recorded for this run — falling back to git status only";
  } else if (!baseline.gitCommit) {
    note = "baseline has no gitCommit — falling back to git status only";
  } else {
    // `-M -C` makes rename/copy detection explicit rather than relying on the
    // caller's `diff.renames` config — see parseAddedFromDiff's doc comment.
    const diffRes = runGit(
      ["diff", "--name-status", "-M", "-C", baseline.gitCommit],
      cwd,
      "computeAddedFilesSinceBaseline",
      budget,
    );
    if (diffRes.ok) {
      for (const p of parseAddedFromDiff(diffRes.stdout)) statusPaths.add(p);
    } else {
      note = `git diff against the baseline commit failed (${diffRes.error}) — used git status only`;
    }
  }

  const alreadyDirtyAtBaseline = new Set(baseline?.dirtyFiles ?? []);
  const files = [...statusPaths]
    .filter((p) => !alreadyDirtyAtBaseline.has(p))
    .filter((p) => !isUnderBuildOutputDir(p))
    .filter((p) => isProjectManifest(p.split("/").pop() ?? p))
    .sort()
    .slice(0, MAX_NEW_MANIFESTS);

  return {
    files,
    source: baseline?.gitCommit ? "git-diff+status" : "git-status-fallback",
    note,
  };
}

// ─── repo-wide solution-file walk ──────────────────────────────────────────

/** Walk `cwd` collecting solution/workspace index files (`isSolutionManifest`). Bounded, best-effort. */
async function collectSolutionFiles(cwd: string): Promise<string[]> {
  const solutions: string[] = [];
  let budget = MAX_WALK_ENTRIES;

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || budget <= 0 || solutions.length >= MAX_SOLUTION_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn(
        "orchestrator",
        `[project-registration-check] cannot read "${dir}": ${err instanceof Error ? err.message : String(err)}`,
        { operation: "collectSolutionFiles", dir },
      );
      return;
    }
    for (const e of entries) {
      if (budget-- <= 0) return;
      if (e.name.startsWith(".") || BUILD_OUTPUT_DIRS.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel, depth + 1);
      } else if (e.isFile() && isSolutionManifest(e.name)) {
        solutions.push(rel);
        if (solutions.length >= MAX_SOLUTION_FILES) return;
      }
    }
  }

  await walk(cwd, "", 0);
  return solutions;
}

// ─── path helpers ───────────────────────────────────────────────────────────

function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `child` (absolute) lives at or under `parentDir` (absolute). */
function isUnder(childAbs: string, parentDirAbs: string): boolean {
  const c = pathKey(path.resolve(childAbs));
  const p = pathKey(path.resolve(parentDirAbs));
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// ─── .sln / .slnx parsing ───────────────────────────────────────────────────

/**
 * `Project("{TypeGuid}") = "Name", "relative\path.csproj", "{ProjectGuid}"` —
 * one line per project OR solution folder. Solution folders share the same
 * grammar but their "path" is not a project manifest (`isProjectManifest`
 * filters them out below), so they never pollute the registered set.
 */
const SLN_PROJECT_LINE_RE = /^Project\("\{[0-9A-Fa-f-]+\}"\)\s*=\s*"[^"]*",\s*"([^"]*)",\s*"\{[0-9A-Fa-f-]+\}"/gm;

/** `<Project Path="relative\path.csproj" .../>` — .slnx's XML grammar, cheap to regex-extract. */
const SLNX_PROJECT_PATH_RE = /<Project\b[^>]*\bPath\s*=\s*"([^"]+)"/g;

/** Read + parse one solution file's registered project paths, as absolute path keys. Null on read/parse failure. */
async function parseSolutionRegisteredProjects(solutionAbsPath: string): Promise<Set<string> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(solutionAbsPath, "utf8");
  } catch (err) {
    logger.warn(
      "orchestrator",
      `[project-registration-check] could not read solution "${solutionAbsPath}": ${err instanceof Error ? err.message : String(err)}`,
      { operation: "parseSolutionRegisteredProjects", solutionAbsPath },
    );
    return null;
  }
  const dir = path.dirname(solutionAbsPath);
  const isSlnx = solutionAbsPath.toLowerCase().endsWith(".slnx");
  const re = isSlnx ? SLNX_PROJECT_PATH_RE : SLN_PROJECT_LINE_RE;
  const registered = new Set<string>();
  for (const m of raw.matchAll(re)) {
    const relRaw = m[1];
    if (!relRaw) continue;
    const relNormalized = relRaw.replace(/\\/g, "/");
    const basename = relNormalized.split("/").pop() ?? "";
    if (!isProjectManifest(basename)) continue; // solution folder or non-project entry
    const abs = path.resolve(dir, relNormalized.split("/").join(path.sep));
    registered.add(pathKey(abs));
  }
  return registered;
}

// ─── solution selection ─────────────────────────────────────────────────────

/**
 * Every ancestor directory of `startDir`, from `startDir` itself up to (and
 * including) `cwd`. Used to find a `.sln`/`.slnx` that sits DIRECTLY inside one
 * of them — "near the new project's ancestor chain".
 */
function ancestorChain(cwd: string, startDir: string): string[] {
  const chain: string[] = [];
  const cwdKey = pathKey(path.resolve(cwd));
  let d = path.resolve(startDir);
  // Bounded by the filesystem's own depth; MAX_WALK_DEPTH is generous enough
  // that a runaway loop here would already have hit a root directory first.
  for (let i = 0; i <= MAX_WALK_DEPTH + 2; i++) {
    chain.push(d);
    if (pathKey(d) === cwdKey) break;
    const parent = path.dirname(d);
    if (parent === d) break; // filesystem root
    d = parent;
  }
  return chain;
}

export type SolutionSelection =
  | { kind: "chosen"; solutionAbsPath: string }
  | { kind: "ambiguous"; candidateCount: number }
  | { kind: "none" };

/**
 * Pick the solution a new manifest must be registered in — see the module doc
 * ("never guess"). `LayoutConvention.solutionFile` always wins when known; it is
 * F4b's own deterministic, dominance-gated pick and applies to the whole repo.
 * Otherwise, only a manifest with EXACTLY ONE `.sln`/`.slnx` directly inside an
 * ancestor directory resolves; two or more is `"ambiguous"`, never a guess.
 */
function selectSolution(opts: {
  cwd: string;
  manifestAbsDir: string;
  layoutConvention: LayoutConvention | null;
  allSolutionAbsPaths: string[];
}): SolutionSelection {
  const { cwd, manifestAbsDir, layoutConvention, allSolutionAbsPaths } = opts;
  if (layoutConvention?.solutionFile) {
    return { kind: "chosen", solutionAbsPath: path.resolve(cwd, layoutConvention.solutionFile) };
  }
  const ancestors = new Set(ancestorChain(cwd, manifestAbsDir).map(pathKey));
  const candidates = allSolutionAbsPaths.filter((s) => ancestors.has(pathKey(path.dirname(s))));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous", candidateCount: candidates.length };
  return { kind: "chosen", solutionAbsPath: candidates[0] as string };
}

// ─── the .NET checker ───────────────────────────────────────────────────────

/** Cache of parsed solutions within one call — several new manifests often resolve to the same solution. */
type SolutionCache = Map<string, Set<string> | null>;

async function getRegisteredProjects(solutionAbsPath: string, cache: SolutionCache): Promise<Set<string> | null> {
  const key = pathKey(solutionAbsPath);
  if (cache.has(key)) return cache.get(key) ?? null;
  const registered = await parseSolutionRegisteredProjects(solutionAbsPath);
  cache.set(key, registered);
  return registered;
}

async function checkDotnetEcosystem(opts: {
  cwd: string;
  layoutConvention: LayoutConvention | null;
  newManifestsRepoRelative: string[];
  allSolutionAbsPaths: string[];
}): Promise<ProjectRegistrationEcosystemResult> {
  const { cwd, layoutConvention, newManifestsRepoRelative, allSolutionAbsPaths } = opts;

  if (allSolutionAbsPaths.length === 0) {
    return { ecosystem: "C#", solutionFile: null, unregistered: [], status: "unsupported" };
  }

  const cache: SolutionCache = new Map();
  // Kept separate from `parseFailures` on purpose: a genuine "not referenced by
  // the solution" is the only thing that produces `formatProjectRegistrationMustFix`
  // text and drives the "violations" status. A solution file that could not be
  // read/parsed proves nothing either way — it must never be reported as a
  // violation (that would tell a fixer to add a project that may already be
  // registered), so it gets its own bucket and its own status priority.
  const violations: UnregisteredManifest[] = [];
  const ambiguous: UnregisteredManifest[] = [];
  const parseFailures: UnregisteredManifest[] = [];
  const usedSolutions = new Set<string>();

  for (const manifestRel of newManifestsRepoRelative.slice(0, MAX_NEW_MANIFESTS)) {
    const manifestAbs = path.resolve(cwd, manifestRel);
    const selection = selectSolution({
      cwd,
      manifestAbsDir: path.dirname(manifestAbs),
      layoutConvention,
      allSolutionAbsPaths,
    });

    if (selection.kind === "none") continue; // no solution in scope — standalone by construction
    if (selection.kind === "ambiguous") {
      if (ambiguous.length < MAX_UNREGISTERED) {
        ambiguous.push({
          manifest: manifestRel,
          reason: `ambiguous — ${selection.candidateCount} solution files sit near this project and none is the repo's known convention; not registering automatically`,
        });
      }
      continue;
    }

    const { solutionAbsPath } = selection;
    const solutionDir = path.dirname(solutionAbsPath);
    if (!isUnder(manifestAbs, solutionDir)) continue; // outside the solution's own tree — standalone

    const registered = await getRegisteredProjects(solutionAbsPath, cache);
    const solutionRel = toPosix(path.relative(cwd, solutionAbsPath));
    if (registered === null) {
      if (parseFailures.length < MAX_UNREGISTERED) {
        parseFailures.push({
          manifest: manifestRel,
          reason: `could not read or parse "${solutionRel}" to confirm registration`,
        });
      }
      continue;
    }
    usedSolutions.add(solutionRel);
    if (!registered.has(pathKey(manifestAbs))) {
      if (violations.length < MAX_UNREGISTERED) {
        violations.push({
          manifest: manifestRel,
          reason: `not referenced by "${solutionRel}"`,
          solutionFile: solutionRel,
        });
      }
    }
  }

  const status: ProjectRegistrationStatus =
    violations.length > 0
      ? "violations"
      : parseFailures.length > 0
        ? "error"
        : ambiguous.length > 0
          ? "ambiguous"
          : "ok";
  const unregistered = [...violations, ...ambiguous, ...parseFailures].slice(0, MAX_UNREGISTERED);

  const solutionFile = layoutConvention?.solutionFile ?? (usedSolutions.size === 1 ? [...usedSolutions][0]! : null);

  return { ecosystem: "C#", solutionFile, unregistered, status };
}

/**
 * Run the real .NET registration check against an EXPLICIT manifest list,
 * bypassing git-based added-file detection entirely.
 *
 * @testonly Production always derives its manifest list from
 * `computeAddedFilesSinceBaseline` (via `checkProjectRegistration`). This
 * entry point exists so a read-only replay against a real repository — one
 * whose interesting manifest is already committed and the tree is clean, so
 * nothing would show up as "added since baseline" — can still exercise the
 * SAME solution-selection and `.sln`/`.slnx` parsing logic, without mutating
 * that repository's git state to manufacture a fake dirty file.
 */
export async function checkDotnetRegistrationForManifests(opts: {
  cwd: string;
  layoutConvention: LayoutConvention | null;
  manifestsRepoRelative: string[];
}): Promise<ProjectRegistrationEcosystemResult> {
  const allSolutionRels = await collectSolutionFiles(opts.cwd);
  const allSolutionAbsPaths = allSolutionRels.map((r) => path.resolve(opts.cwd, r));
  return checkDotnetEcosystem({
    cwd: opts.cwd,
    layoutConvention: opts.layoutConvention,
    newManifestsRepoRelative: opts.manifestsRepoRelative,
    allSolutionAbsPaths,
  });
}

// ─── orchestrator ────────────────────────────────────────────────────────────

/** Manifest types this module knows how to check for real. Everything else is `"unsupported"`. */
const SUPPORTED_MANIFEST_TYPES: ReadonlySet<ManifestSpec["type"]> = new Set(["csproj"]);

export interface CheckProjectRegistrationOpts {
  cwd: string;
  baseline: VerifyBaseline | null;
  /** Test-only / caller override; defaults to `scanLayoutConvention(cwd)`. */
  layoutConvention?: LayoutConvention | null;
}

/**
 * The whole check: compute what was added since baseline, group the new
 * project manifests by ecosystem, and check each ecosystem's registration.
 * Never throws — every failure path returns `status: "error"` (for a git
 * failure, before ecosystems are even known) or is logged and downgraded to
 * `"unsupported"`/skipped, per the "never guess, never silently open" rule
 * shared with `verify-baseline.ts`.
 */
export async function checkProjectRegistration(
  opts: CheckProjectRegistrationOpts,
): Promise<ProjectRegistrationCheckResult> {
  const { cwd, baseline } = opts;

  const added = await computeAddedFilesSinceBaseline(cwd, baseline);
  if (added.error) {
    logger.error(
      "orchestrator",
      `[project-registration-check] could not determine files added since baseline: ${added.error}`,
      { operation: "checkProjectRegistration", cwd },
    );
    return {
      ecosystems: [{ ecosystem: "unknown", solutionFile: null, unregistered: [], status: "error" }],
      addedFilesSource: added.source,
      addedFilesCount: 0,
      error: added.error,
    };
  }

  const newManifestsByType = new Map<ManifestSpec["type"], { lang: string; rels: string[] }>();
  for (const rel of added.files) {
    const basename = rel.split("/").pop() ?? rel;
    // `computeAddedFilesSinceBaseline` already filters to project manifests
    // before its own bound — this check is defense-in-depth, not the primary
    // filter, so a future caller of that function directly is never surprised.
    if (!isProjectManifest(basename)) continue;
    const spec = matchManifest(basename);
    if (!spec) continue;
    const bucket = newManifestsByType.get(spec.type) ?? { lang: spec.lang, rels: [] };
    if (bucket.rels.length < MAX_NEW_MANIFESTS) bucket.rels.push(rel);
    newManifestsByType.set(spec.type, bucket);
  }

  if (newManifestsByType.size === 0) {
    return { ecosystems: [], addedFilesSource: added.source, addedFilesCount: added.files.length, note: added.note };
  }

  let layoutConvention: LayoutConvention | null;
  if (opts.layoutConvention !== undefined) {
    layoutConvention = opts.layoutConvention;
  } else {
    try {
      layoutConvention = await scanLayoutConvention(cwd);
    } catch (err) {
      logger.error(
        "orchestrator",
        `[project-registration-check] scanLayoutConvention failed: ${err instanceof Error ? err.message : String(err)}`,
        { operation: "checkProjectRegistration", cwd },
      );
      layoutConvention = null;
    }
  }

  let allSolutionRels: string[] = [];
  try {
    allSolutionRels = await collectSolutionFiles(cwd);
  } catch (err) {
    logger.error(
      "orchestrator",
      `[project-registration-check] collectSolutionFiles failed: ${err instanceof Error ? err.message : String(err)}`,
      { operation: "checkProjectRegistration", cwd },
    );
  }
  const allSolutionAbsPaths = allSolutionRels.map((r) => path.resolve(cwd, r));

  const ecosystems: ProjectRegistrationEcosystemResult[] = [];
  for (const [type, bucket] of newManifestsByType) {
    if (!SUPPORTED_MANIFEST_TYPES.has(type)) {
      logger.debug(
        "orchestrator",
        `[project-registration-check] ecosystem "${bucket.lang}" (manifest type "${type}") has no workspace-membership checker implemented — reporting unsupported`,
        { operation: "checkProjectRegistration", ecosystem: bucket.lang, type },
      );
      ecosystems.push({ ecosystem: bucket.lang, solutionFile: null, unregistered: [], status: "unsupported" });
      continue;
    }
    try {
      ecosystems.push(
        await checkDotnetEcosystem({
          cwd,
          layoutConvention,
          newManifestsRepoRelative: bucket.rels,
          allSolutionAbsPaths,
        }),
      );
    } catch (err) {
      logger.error(
        "orchestrator",
        `[project-registration-check] .NET ecosystem check failed: ${err instanceof Error ? err.message : String(err)}`,
        { operation: "checkProjectRegistration", cwd },
      );
      ecosystems.push({ ecosystem: bucket.lang, solutionFile: null, unregistered: [], status: "error" });
    }
  }

  return { ecosystems, addedFilesSource: added.source, addedFilesCount: added.files.length, note: added.note };
}

// ─── result helpers ─────────────────────────────────────────────────────────

export function hasProjectRegistrationViolations(result: ProjectRegistrationCheckResult | undefined): boolean {
  return !!result?.ecosystems.some((e) => e.status === "violations");
}

/**
 * Exact wording the S4 verify-fix loop's fixer prompt (and `nextFocus`) carry —
 * see `sprint-runner.ts`. Named per manifest, with the ready-made `dotnet sln`
 * command, because the checker (not the model) already knows both paths.
 */
export function formatProjectRegistrationMustFix(result: ProjectRegistrationCheckResult | undefined): string | null {
  if (!result) return null;
  const lines: string[] = [];
  for (const eco of result.ecosystems) {
    if (eco.status !== "violations") continue;
    for (const u of eco.unregistered) {
      if (!u.solutionFile) continue;
      lines.push(
        `Register \`${u.manifest}\` in \`${u.solutionFile}\` (e.g. \`dotnet sln ${u.solutionFile} add ${u.manifest}\`).`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Human-readable note for `sprints/<n>-verify.md`. Null when there is nothing worth saying. */
export function formatProjectRegistrationNote(result: ProjectRegistrationCheckResult | undefined): string | null {
  if (!result) return null;
  if (result.error) return `[project-registration] could not run: ${result.error}`;
  const worthReporting = result.ecosystems.filter((e) => e.status !== "ok" && e.status !== "unsupported");
  if (worthReporting.length === 0) return null;
  const lines = ["[project-registration]"];
  for (const eco of worthReporting) {
    if (eco.status === "violations") {
      lines.push(
        `- ${eco.ecosystem}: ${eco.unregistered.length} project(s) not registered in ${eco.solutionFile ?? "the solution"}.`,
      );
      for (const u of eco.unregistered) lines.push(`  - ${u.manifest}: ${u.reason}`);
    } else if (eco.status === "ambiguous") {
      lines.push(
        `- ${eco.ecosystem}: solution ownership is ambiguous for ${eco.unregistered.length} new project(s) — not registering automatically.`,
      );
    } else if (eco.status === "error") {
      lines.push(`- ${eco.ecosystem}: the registration check failed to run.`);
    }
  }
  return lines.join("\n");
}
