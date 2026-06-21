/**
 * src/orchestrator/auto-commit.ts
 *
 * Deterministic "task done -> commit" enforcement (user directive 2026-06-21:
 * the soft prompt rule "commit incrementally" was being ignored, so commits did
 * not actually happen in real use). At the end of a successful agentic turn this
 * auto-commits ONLY the files the agent changed during that turn, with the
 * required attribution line.
 *
 * Scoping is by snapshot-diff, NOT a file-mutation tracker: we record the set of
 * dirty/untracked paths BEFORE the turn and commit only paths that became dirty
 * DURING it (dirtyAfter - dirtyBefore). This deliberately skips any file the user
 * already had uncommitted before the turn — auto-commit must never fold a user's
 * unrelated work-in-progress into an agent commit.
 *
 * Safety gates: git repo only · `MUONROI_AUTO_COMMIT=0` opt-out · never under
 * unit tests (VITEST) · a sensitive-path denylist (.env / keys / secrets /
 * .muonroi-cli) · fail-soft (a git error is logged, never breaks the turn).
 *
 * git is invoked via execFile with an argument array (no shell) so file paths
 * cannot inject shell commands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Attribution line every auto-commit message ends with (mirrors the prompt rule). */
export const AUTO_COMMIT_ATTRIBUTION = "Coding by - Muonroi-CLI";

/** Paths we must never auto-stage, regardless of who changed them (secrets). */
const SENSITIVE_RE =
  /(^|\/)(\.env(\.[^/]*)?$|.*\.pem$|.*\.key$|.*\.p12$|.*\.pfx$|.*secret.*|.*credential.*|id_rsa|id_ed25519)/i;

/**
 * CLI-generated artifacts + build/dependency junk that must not be swept into an
 * agent commit. The snapshot-diff catches everything that became dirty during the
 * turn — including the CLI's OWN session/flow state (all `.muonroi-*`) which it
 * writes into cwd. Real user repos usually gitignore node_modules/dist (so git
 * status hides them), but exclude them too for repos that don't.
 */
const ARTIFACT_RE =
  /(^|\/)(\.muonroi-|node_modules\/|dist\/|build\/|coverage\/|\.next\/|\.turbo\/|\.git\/)|(^|\/)\.DS_Store$|\.log$/i;

export interface AutoCommitResult {
  committed: boolean;
  sha?: string;
  fileCount?: number;
  reason?: string;
}

export function isAutoCommitEnabled(): boolean {
  if (process.env.MUONROI_AUTO_COMMIT === "0") return false;
  // Never auto-commit while the unit-test suite runs — it executes in the repo
  // working tree and would commit junk.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  return true;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await pexecFile("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, ok: true };
  } catch {
    // Expected for non-repos / hook rejections / nothing-to-commit — caller maps
    // !ok to a skip reason; no throw escapes (fail-soft by contract).
    return { stdout: "", ok: false };
  }
}

/**
 * Parse `git status --porcelain` output into the set of changed paths. Handles
 * renames (`orig -> new`, keeps the new path) and quoted paths with spaces.
 */
export function parsePorcelainPaths(out: string): Set<string> {
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3); // strip the 2-char XY status + the separating space
    if (path.includes(" -> ")) path = path.slice(path.indexOf(" -> ") + 4);
    path = path.trim().replace(/^"(.*)"$/, "$1");
    if (path) set.add(path);
  }
  return set;
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_RE.test(path);
}

/** CLI artifact / build junk that must never be folded into an agent commit. */
export function isCliArtifactPath(path: string): boolean {
  return ARTIFACT_RE.test(path);
}

/** Any path the auto-commit must skip: a secret or a CLI/build artifact. */
export function isExcludedPath(path: string): boolean {
  return isSensitivePath(path) || isCliArtifactPath(path);
}

/**
 * Backstop subject naming the changed FILES — used only by the deterministic
 * end-of-turn safety net (when the agent did not commit its own work via the
 * git_commit tool). Deliberately NOT derived from the raw user prompt (a
 * truncated prompt is meaningless, especially for a multi-step plan); a file list
 * at least says what changed. The meaningful, model-authored message is the
 * git_commit tool's job (the agent writes it per chunk/plan-step).
 */
export function buildFileListSubject(paths: string[]): string {
  const names = paths.map((p) => p.split("/").pop() || p);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  return `chore: update ${paths.length} file(s) — ${shown}${more}`.slice(0, 72);
}

/**
 * Split an AGENT-authored message into a bounded subject (first line, <=72 so it
 * passes conventional-commit hooks) and a bounded body. Strips CRs and drops any
 * attribution line the agent already added (we append exactly one ourselves).
 * Callers pass subject/body/attribution as SEPARATE `-m` flags so git inserts the
 * blank-line separators itself — embedding "\n\n" in a single `-m` arg gets
 * mangled by Windows execFile (the attribution then glues onto the subject).
 */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const lines = message
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== AUTO_COMMIT_ATTRIBUTION);
  const subject = (lines[0] ?? "").trim().slice(0, 72);
  const body = lines.slice(1).join("\n").trim().slice(0, 2000);
  return { subject, body };
}

/** Snapshot the dirty/untracked path set before a turn (empty when not a repo). */
export async function snapshotDirtyPaths(cwd: string): Promise<Set<string>> {
  const r = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return new Set();
  return parsePorcelainPaths(r.stdout);
}

/**
 * Commit the files the agent changed this turn. `dirtyBefore` is the snapshot
 * from before the turn. Returns a result describing what happened; never throws.
 */
export async function maybeAutoCommitTurn(opts: {
  cwd: string;
  dirtyBefore: Set<string>;
  userMessage: string;
}): Promise<AutoCommitResult> {
  if (!isAutoCommitEnabled()) return { committed: false, reason: "disabled" };
  const { cwd, dirtyBefore, userMessage } = opts;

  const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") return { committed: false, reason: "not-a-repo" };

  const dirtyAfter = await snapshotDirtyPaths(cwd);
  const newPaths = [...dirtyAfter].filter((p) => !dirtyBefore.has(p) && !isExcludedPath(p));
  if (newPaths.length === 0) return { committed: false, reason: "no-agent-changes" };

  const add = await git(cwd, ["add", "--", ...newPaths]);
  if (!add.ok) {
    console.error(`[auto-commit] git add failed for ${newPaths.length} path(s) in ${cwd}`);
    return { committed: false, reason: "add-failed" };
  }

  // Separate -m flags → git inserts the blank line between subject and
  // attribution (Windows-safe; embedded "\n\n" in one -m arg gets mangled).
  // Scope the commit to exactly the agent's paths (pathspec).
  const commit = await git(cwd, [
    "commit",
    "-m",
    buildFileListSubject(newPaths),
    "-m",
    AUTO_COMMIT_ATTRIBUTION,
    "--",
    ...newPaths,
  ]);
  if (!commit.ok) {
    console.error(`[auto-commit] git commit failed in ${cwd} (a pre-commit/commit-msg hook may have rejected it)`);
    return { committed: false, reason: "commit-failed" };
  }

  const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, sha: head.ok ? head.stdout.trim() : undefined, fileCount: newPaths.length };
}

/**
 * Commit a SPECIFIC set of paths (absolute or repo-relative) with an
 * AGENT-AUTHORED message — backs the git_commit tool. Stages only `paths` (minus
 * secrets/artifacts), commits with the model's message + the attribution line,
 * scoped by pathspec. No-op if nothing among `paths` is actually staged
 * (e.g. already committed). Never throws.
 */
export async function commitSpecificPaths(cwd: string, paths: string[], message: string): Promise<AutoCommitResult> {
  if (process.env.MUONROI_AUTO_COMMIT === "0") return { committed: false, reason: "disabled" };
  const safe = paths.filter((p) => !isExcludedPath(p));
  if (safe.length === 0) return { committed: false, reason: "no-eligible-paths" };
  const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") return { committed: false, reason: "not-a-repo" };

  const add = await git(cwd, ["add", "--", ...safe]);
  if (!add.ok) {
    console.error(`[git_commit] git add failed for ${safe.length} path(s) in ${cwd}`);
    return { committed: false, reason: "add-failed" };
  }
  // Only commit if these paths actually have staged changes (idempotent across
  // repeat calls — already-committed files stage nothing).
  const staged = await git(cwd, ["diff", "--cached", "--name-only", "--", ...safe]);
  if (!staged.ok || !staged.stdout.trim()) return { committed: false, reason: "nothing-staged" };

  const { subject, body } = splitCommitMessage(message);
  // Separate -m flags so git inserts the blank-line separators itself.
  const mArgs = body
    ? ["-m", subject, "-m", body, "-m", AUTO_COMMIT_ATTRIBUTION]
    : ["-m", subject, "-m", AUTO_COMMIT_ATTRIBUTION];
  const commit = await git(cwd, ["commit", ...mArgs, "--", ...safe]);
  if (!commit.ok) {
    console.error(`[git_commit] git commit failed in ${cwd} (a pre-commit/commit-msg hook may have rejected it)`);
    return { committed: false, reason: "commit-failed" };
  }
  const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return {
    committed: true,
    sha: head.ok ? head.stdout.trim() : undefined,
    fileCount: staged.stdout.trim().split("\n").length,
  };
}
