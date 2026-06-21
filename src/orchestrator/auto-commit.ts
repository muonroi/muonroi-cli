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

/** Build a concise, conventional, <=72-char commit subject from the user prompt. */
export function buildAutoCommitSubject(userMessage: string, fileCount: number): string {
  const firstLine = (userMessage.split("\n")[0] || "")
    .replace(/[`"\r]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const subject = firstLine ? `chore: ${firstLine}` : `chore: agent changes (${fileCount} file(s))`;
  return subject.slice(0, 72);
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

  const message = `${buildAutoCommitSubject(userMessage, newPaths.length)}\n\n${AUTO_COMMIT_ATTRIBUTION}`;
  // Scope the commit to exactly the agent's paths (pathspec) so a concurrently
  // staged file from elsewhere is not swept in.
  const commit = await git(cwd, ["commit", "-m", message, "--", ...newPaths]);
  if (!commit.ok) {
    console.error(`[auto-commit] git commit failed in ${cwd} (a pre-commit/commit-msg hook may have rejected it)`);
    return { committed: false, reason: "commit-failed" };
  }

  const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, sha: head.ok ? head.stdout.trim() : undefined, fileCount: newPaths.length };
}
