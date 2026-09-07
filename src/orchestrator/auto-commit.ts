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
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { LspDiagnostic, LspDiagnosticFile } from "../lsp/types.js";
import { logger } from "../utils/logger.js";

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
  /** G1: when reason === "lsp-errors", the per-file diagnostic summary the agent should fix. */
  detail?: string;
}

/**
 * G1 commit quality gate. Default ON; disable with `MUONROI_COMMIT_GATE=0`
 * (mirrors the `MUONROI_AUTO_COMMIT=0` convention). Off automatically under the
 * unit-test suite so specs that commit fixtures aren't gated.
 */
export function isCommitGateEnabled(): boolean {
  if (process.env.MUONROI_COMMIT_GATE === "0") return false;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  return true;
}

/**
 * G1: per-file LSP-errors gate. Runs the SAME LSP diagnostics produced at
 * write-time on each staged path; blocks the commit if any staged file has an
 * ERROR (severity 1). Scoped to each file's OWN diagnostics so unrelated repo
 * breakage never blocks. Files with no registered LSP server return no
 * diagnostics and pass (so docs/config/non-source commits are unaffected).
 *
 * Fails OPEN on timeout or any error — the gate must never hang a turn or block
 * a commit on its own failure. Only a clean, in-budget run with a real
 * severity-1 diagnostic blocks.
 */
/**
 * G1 (pure): the gate's BLOCK decision for one staged file — its own
 * severity-1 (error) diagnostics. Scoped by absolute path so a diagnostic LSP
 * reports against a DIFFERENT file (cross-file type breakage) never blocks this
 * commit, and warnings/infos (severity >= 2) are ignored. Exported for testing.
 */
export function blockingErrorsForFile(diagFiles: LspDiagnosticFile[], absPath: string): LspDiagnostic[] {
  const out: LspDiagnostic[] = [];
  for (const f of diagFiles) {
    if (resolve(f.filePath) !== absPath) continue;
    for (const d of f.diagnostics) {
      if ((d.severity ?? 1) === 1) out.push(d);
    }
  }
  return out;
}

export async function gateStagedPaths(
  cwd: string,
  paths: string[],
  budgetMs = 9_000,
): Promise<{ ok: boolean; summary?: string }> {
  if (!isCommitGateEnabled()) return { ok: true };
  try {
    const { readFile } = await import("node:fs/promises");
    const { syncFileWithLsp, summarizeDiagnostics } = await import("../lsp/runtime.js");

    // Per-file diagnostics wait. The LSP default (1.5s) is fine for a WARM
    // server (diagnostics cached) but a COLD tsserver loading the project on
    // the first file pushes publishDiagnostics later — so a commit issued
    // seconds after the first edit would slip past a 1.5s wait. Wait longer per
    // file, bounded by the overall budgetMs (fail-open) so the gate can't hang.
    const perFileWaitMs = 4_000;
    const errorFiles: LspDiagnosticFile[] = [];
    const work = (async () => {
      for (const p of paths) {
        const abs = resolve(cwd, p);
        let content: string;
        try {
          content = await readFile(abs, "utf8");
        } catch {
          continue; // deleted / binary / unreadable → nothing to gate
        }
        const diags = await syncFileWithLsp(cwd, abs, content, false, true, perFileWaitMs).catch(
          () => [] as LspDiagnosticFile[],
        );
        const errs = blockingErrorsForFile(diags, abs);
        if (errs.length > 0) {
          const serverId = diags.find((f) => resolve(f.filePath) === abs)?.serverId ?? "lsp";
          errorFiles.push({ filePath: abs, serverId, diagnostics: errs });
        }
      }
    })();

    const TIMED_OUT = Symbol("timeout");
    const outcome = await Promise.race([
      work.then(() => "done" as const),
      new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), budgetMs)),
    ]);
    if (outcome === TIMED_OUT) {
      logger.error("orchestrator", `[commit-gate] LSP gate exceeded ${budgetMs}ms — allowing commit (fail-open)`);
      return { ok: true };
    }
    if (errorFiles.length === 0) return { ok: true };
    const summary = summarizeDiagnostics(errorFiles) ?? `${errorFiles.length} file(s) have LSP errors`;
    return { ok: false, summary };
  } catch (err) {
    logger.error("orchestrator", "gate failed open", {
      error: err,
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    return { ok: true };
  }
}

/**
 * G1 follow-up: the set of paths a bash-tool `git commit` would include, so the
 * LSP commit gate can run on them. A raw `git commit` (unlike the `git_commit`
 * tool) doesn't tell us its paths, so derive them from git state:
 *   - always: the already-staged set (`git diff --cached --name-only`)
 *   - `git commit -a`: + tracked modifications it auto-stages at commit time
 *     (`git diff --name-only`)
 *   - `git add -A`/`.`/`--all` chained in the SAME command: + the whole
 *     working-tree change set (`git status --porcelain`), since the add hasn't
 *     run yet at pre-exec time so it isn't reflected in `--cached`.
 * Deleted/binary/unreadable paths are skipped later by gateStagedPaths when it
 * reads them. KNOWN GAP: `git add <specific-path> && git commit` in one command
 * where <specific-path> was not pre-staged is NOT covered (we don't parse
 * pathspecs); the `git_commit` tool + auto-commit backstop remain the primary
 * gates. Returns repo-relative paths (gateStagedPaths resolves them against cwd).
 */
export async function pathsForCommitGate(
  cwd: string,
  opts: { broadAdd: boolean; commitAll: boolean },
): Promise<string[]> {
  const set = new Set<string>();
  const addLines = (out: string) => {
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p) set.add(p);
    }
  };
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (staged.ok) addLines(staged.stdout);
  if (opts.broadAdd) {
    // `git add -A/.` stages every working-tree change; `--porcelain` enumerates
    // exactly that superset (and omits gitignored dirs like node_modules/dist).
    const status = await git(cwd, ["status", "--porcelain"]);
    if (status.ok) for (const p of parsePorcelainPaths(status.stdout)) set.add(p);
  } else if (opts.commitAll) {
    // `git commit -a` auto-stages tracked modifications (not untracked files).
    const mod = await git(cwd, ["diff", "--name-only"]);
    if (mod.ok) addLines(mod.stdout);
  }
  return [...set];
}

export function isAutoCommitEnabled(): boolean {
  if (process.env.MUONROI_AUTO_COMMIT === "0") return false;
  // Never auto-commit while the unit-test suite runs — it executes in the repo
  // working tree and would commit junk.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  return true;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean; stderr: string; code: number | null }> {
  try {
    const { stdout } = await pexecFile("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, ok: true, stderr: "", code: 0 };
  } catch (err) {
    // Expected for non-repos / hook rejections / nothing-to-commit — caller maps
    // !ok to a skip reason; no throw escapes (fail-soft by contract). We do NOT
    // log here (an expected !ok on `rev-parse` is not an error), but we DO carry
    // git's own stderr + exit code out so the callers that treat !ok as a real
    // failure can say WHY. Without this a failed `git add` was unattributable:
    // session 811336618ee0 logged "git add failed for 1 path(s)" and nothing else.
    const e = err as { stderr?: string | Buffer; code?: number; message?: string };
    const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString()) ?? e?.message ?? "";
    return { stdout: "", ok: false, stderr: stderr.trim(), code: typeof e?.code === "number" ? e.code : null };
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

/* ------------------------------------------------------------------------- *
 * Run-root containment gate (incident 2026-09-06)
 *
 * A run confined to one directory must not be able to write git history
 * outside it. It could:
 *
 *   `/ideal` was launched in the linked worktree `D:\...\muonroi-cli\.sprint-a7`
 *   (process.chdir at src/index.ts:735 via `-d`, so BashTool started there —
 *   src/orchestrator/orchestrator.ts:489 `new BashTool(process.cwd())`, and
 *   sessions.cwd_at_start recorded `...\.sprint-a7`). At 2026-09-06T10:15:04Z a
 *   sub-agent ran `cd D:/sources/Core/muonroi-cli && git log --oneline -5`. The
 *   bash tool's `cd` handler mutates BashTool.cwd with NO containment check
 *   (src/tools/bash.ts:170 `this.cwd = nextCwd`), so the tool cwd moved
 *   permanently to the PARENT repo. Both commit entry points read that same
 *   cwd — orchestrator.ts:3590 `const cwd = this.bash.getCwd()` and
 *   src/tools/registry.ts:836 `commitSpecificPaths(bash.getCwd(), ...)` — so
 *   three commits landed on the parent repo's branch (b3ff377e, 8cbc08b7,
 *   29b5abfe) while the run believed it was confined to the worktree.
 *
 * The invariant enforced here: the git worktree root of the commit cwd must
 * equal the git worktree root of the directory the run was LAUNCHED in. A `cd`
 * into a SUB-directory of the same repo keeps the same toplevel and is
 * unaffected (ordinary sessions are untouched); a `cd` into a different repo —
 * or, as here, out of a linked worktree into its parent, which git reports as a
 * DIFFERENT toplevel — is refused before anything is staged.
 *
 * Fails LOUD, never silent: a block is logged AND returned as an explicit
 * `outside-run-root` reason carrying both roots, which the orchestrator prints
 * in the transcript and the git_commit tool hands back to the agent.
 * ------------------------------------------------------------------------- */

/** Pinned launch directory; `null` means "derive from process.cwd()". */
let commitRunRoot: string | null = null;

/**
 * Pin the directory this run is confined to. Normally unnecessary — the default
 * (`process.cwd()`) already IS the `-d` directory, because index.ts chdirs into
 * it before anything else boots and nothing else in src/ ever calls chdir.
 * Exported as the wiring/test seam.
 */
export function setCommitRunRoot(dir: string | null): void {
  commitRunRoot = dir === null ? null : resolve(dir);
}

/** The directory this run is confined to. */
export function getCommitRunRoot(): string {
  return commitRunRoot ?? process.cwd();
}

/**
 * Default ON. `MUONROI_COMMIT_SCOPE=0` is a USER escape hatch (mirrors the
 * `MUONROI_AUTO_COMMIT=0` / `MUONROI_COMMIT_GATE=0` convention) for the rare
 * session that deliberately drives commits across repos. Deliberately never
 * surfaced to the model — same treatment as the LSP gate's bypass.
 */
export function isCommitScopeGuardEnabled(): boolean {
  return process.env.MUONROI_COMMIT_SCOPE !== "0";
}

/** Absolute git worktree root for `dir`, or null when `dir` is not in a repo. */
async function worktreeRoot(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return null;
  const top = r.stdout.trim();
  return top ? resolve(top) : null;
}

export interface CommitScopeVerdict {
  ok: boolean;
  /** The directory the run was launched in. */
  runRoot: string;
  /** Worktree root of the cwd the commit would run in (null = not a repo). */
  commitRoot: string | null;
  /** Worktree root of `runRoot` (null = the run did not start inside a repo). */
  expectedRoot: string | null;
}

/**
 * Decide whether a commit issued with `cwd` writes history this run owns.
 * Never throws — a git failure resolves to `null` roots and is handled below.
 */
export async function checkCommitScope(cwd: string): Promise<CommitScopeVerdict> {
  const runRoot = getCommitRunRoot();
  if (!isCommitScopeGuardEnabled()) return { ok: true, runRoot, commitRoot: null, expectedRoot: null };

  const expectedRoot = await worktreeRoot(runRoot);
  // The run did not start inside a repo, so it has no history of its own to be
  // confined to and there is nothing to compare against. Allow (this is not the
  // incident shape — that run was launched inside a worktree).
  if (!expectedRoot) return { ok: true, runRoot, commitRoot: null, expectedRoot: null };

  const commitRoot = await worktreeRoot(cwd);
  return { ok: commitRoot !== null && commitRoot === expectedRoot, runRoot, commitRoot, expectedRoot };
}

/** The operator-facing explanation of a refused commit. Used for log + result detail. */
export function describeCommitScopeBlock(cwd: string, v: CommitScopeVerdict): string {
  return (
    `commit target is OUTSIDE this run's directory — nothing was staged or committed. ` +
    `cwd=${cwd} (repo ${v.commitRoot ?? "<not a repo>"}), but the run was launched in ` +
    `${v.runRoot} (repo ${v.expectedRoot}). The tool cwd most likely drifted out of the ` +
    `launch directory via a \`cd\`. Run the CLI from the repo you intend to commit to.`
  );
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

  // Containment gate — before ANY staging. See "Run-root containment gate" above.
  const scope = await checkCommitScope(cwd);
  if (!scope.ok) {
    const detail = describeCommitScopeBlock(cwd, scope);
    logger.error("orchestrator", `[auto-commit] REFUSED — ${detail}`);
    return { committed: false, reason: "outside-run-root", detail };
  }

  const dirtyAfter = await snapshotDirtyPaths(cwd);
  const newPaths = [...dirtyAfter].filter((p) => !dirtyBefore.has(p) && !isExcludedPath(p));
  if (newPaths.length === 0) return { committed: false, reason: "no-agent-changes" };

  const add = await git(cwd, ["add", "--", ...newPaths]);
  if (!add.ok) {
    // Log the paths AND git's own stderr — "failed for N path(s)" alone is not
    // diagnosable after the fact (the usual causes — an ignored path, a lock
    // file, a permission error — are only distinguishable from stderr).
    logger.error(
      "orchestrator",
      `[auto-commit] git add failed (exit ${add.code ?? "?"}) for ${newPaths.length} path(s) in ${cwd}: ${newPaths.join(", ")}${add.stderr ? ` — ${add.stderr.slice(0, 500)}` : " — (git produced no stderr)"}`,
    );
    return { committed: false, reason: "add-failed", detail: add.stderr || undefined };
  }

  // G1 quality gate: do NOT auto-commit code that fails LSP error checks. The
  // backstop simply skips (no spurious chore commit of broken code); the agent
  // will see/fix it next turn. Staged paths stay staged (idempotent).
  const gate = await gateStagedPaths(cwd, newPaths);
  if (!gate.ok) {
    logger.error("orchestrator", `[auto-commit] skipped — staged files have LSP errors:\n${gate.summary}`);
    return { committed: false, reason: "lsp-errors", detail: gate.summary };
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
    logger.error(
      "orchestrator",
      `[auto-commit] git commit failed (exit ${commit.code ?? "?"}) in ${cwd} (a pre-commit/commit-msg hook may have rejected it)${commit.stderr ? `: ${commit.stderr.slice(0, 500)}` : " — (git produced no stderr)"}`,
    );
    return { committed: false, reason: "commit-failed", detail: commit.stderr || undefined };
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

  // Containment gate — before ANY staging. See "Run-root containment gate" above.
  const scope = await checkCommitScope(cwd);
  if (!scope.ok) {
    const detail = describeCommitScopeBlock(cwd, scope);
    logger.error("orchestrator", `[git_commit] REFUSED — ${detail}`);
    return { committed: false, reason: "outside-run-root", detail };
  }

  const add = await git(cwd, ["add", "--", ...safe]);
  if (!add.ok) {
    logger.error(
      "orchestrator",
      `[git_commit] git add failed (exit ${add.code ?? "?"}) for ${safe.length} path(s) in ${cwd}: ${safe.join(", ")}${add.stderr ? ` — ${add.stderr.slice(0, 500)}` : " — (git produced no stderr)"}`,
    );
    return { committed: false, reason: "add-failed", detail: add.stderr || undefined };
  }
  // Only commit if these paths actually have staged changes (idempotent across
  // repeat calls — already-committed files stage nothing).
  const staged = await git(cwd, ["diff", "--cached", "--name-only", "--", ...safe]);
  if (!staged.ok || !staged.stdout.trim()) return { committed: false, reason: "nothing-staged" };

  // G1 quality gate: block the commit if any staged file has an LSP error. The
  // git_commit tool surfaces reason+detail so the agent can fix and recommit.
  const gate = await gateStagedPaths(cwd, safe);
  if (!gate.ok) {
    return { committed: false, reason: "lsp-errors", detail: gate.summary };
  }

  const { subject, body } = splitCommitMessage(message);
  // Separate -m flags so git inserts the blank-line separators itself.
  const mArgs = body
    ? ["-m", subject, "-m", body, "-m", AUTO_COMMIT_ATTRIBUTION]
    : ["-m", subject, "-m", AUTO_COMMIT_ATTRIBUTION];
  const commit = await git(cwd, ["commit", ...mArgs, "--", ...safe]);
  if (!commit.ok) {
    logger.error(
      "orchestrator",
      `[git_commit] git commit failed (exit ${commit.code ?? "?"}) in ${cwd} (a pre-commit/commit-msg hook may have rejected it)${commit.stderr ? `: ${commit.stderr.slice(0, 500)}` : " — (git produced no stderr)"}`,
    );
    return { committed: false, reason: "commit-failed", detail: commit.stderr || undefined };
  }
  const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return {
    committed: true,
    sha: head.ok ? head.stdout.trim() : undefined,
    fileCount: staged.stdout.trim().split("\n").length,
  };
}
