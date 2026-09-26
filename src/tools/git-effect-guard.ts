/**
 * src/tools/git-effect-guard.ts
 *
 * Round 3 — string parsing of an arbitrary shell command line is an arms
 * race: a refuter kept finding new spellings of "git" (`\git`, `git -c
 * alias.x=commit x`, `git${IFS}commit`, `echo commit | xargs git`, ...) that
 * `git-safety.ts`'s `detectBlockedGitSubcommand` (a text classifier) either
 * missed or, in the `git tag -l` case, over-blocked. Text classification
 * cannot be made complete against an adversarial command line — there is
 * always one more way to spell a word a shell will still execute.
 *
 * This module makes the `autoCommit: false` guarantee EFFECT-BASED instead:
 * regardless of HOW the command spelled "git", if it moved or created a ref,
 * that is undone after the fact.
 *
 * Contract (see `runWithGitEffectGuard`):
 *   1. Before the command runs: snapshot every ref (`for-each-ref`), HEAD,
 *      the HEAD reflog length, and `git stash list`. A no-op (not a git
 *      repo, or the project has not disabled autoCommit) returns `null` —
 *      the caller runs the command with no wrapping at all.
 *   2. Run the command.
 *   3. After: re-snapshot and diff.
 *      - A ref that changed value is restored to its snapshot SHA via
 *        `git update-ref <ref> <old-sha>`.
 *      - A ref that did not exist before is deleted via `git update-ref -d`.
 *      - The commits themselves are NOT deleted (unreachable-but-present,
 *        recoverable via reflog for a good while) — only the ref that made
 *        them reachable moves back. Nothing is lost; the tool result is
 *        simply marked an error so the model (and the user, reading the
 *        transcript) knows the write did not stick.
 *   4. `git push` is a SEPARATE, still string-based concern
 *      (`detectBlockedGitSubcommand`/registry.ts) — a push cannot be undone
 *      once a remote has it, so it must still be caught BEFORE execution;
 *      this module only ever repairs LOCAL ref state.
 */
import { spawnSync } from "node:child_process";
import { logger } from "../utils/logger.js";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error)?.message ?? "spawn failed" };
  }
}

/** True when `cwd` is inside a git working tree. Never throws. */
export function isInsideGitRepo(cwd: string): boolean {
  const r = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

export interface GitEffectSnapshot {
  /** refname -> objectname (sha), from `for-each-ref`. Includes `refs/stash` when present. */
  refs: Record<string, string>;
  /** `git rev-parse HEAD` — null on a repo with no commits yet (or detached-HEAD-less edge cases). */
  headSha: string | null;
  /** Line count of `git reflog show HEAD` — an extra detection signal, not itself restored. */
  reflogCount: number;
  /** Raw `git stash list` output — an extra detection signal, not itself restored. */
  stashList: string;
}

/** Snapshot every ref + HEAD + the HEAD reflog length + the stash list. Never throws. */
export function snapshotGitEffects(cwd: string): GitEffectSnapshot {
  const refs: Record<string, string> = {};
  const refsOut = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  if (refsOut.ok) {
    for (const line of refsOut.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.lastIndexOf(" ");
      if (idx < 0) continue;
      refs[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  const headOut = git(cwd, ["rev-parse", "HEAD"]);
  const headSha = headOut.ok && headOut.stdout.trim() ? headOut.stdout.trim() : null;
  const reflogOut = git(cwd, ["reflog", "show", "HEAD"]);
  const reflogCount = reflogOut.ok ? reflogOut.stdout.split("\n").filter((l) => l.trim()).length : 0;
  const stashOut = git(cwd, ["stash", "list"]);
  const stashList = stashOut.ok ? stashOut.stdout : "";
  return { refs, headSha, reflogCount, stashList };
}

export interface GitEffectViolation {
  /** Every ref name (including the synthetic `"HEAD"`) that changed or was created. */
  changedRefs: string[];
  /** Refs successfully restored to their snapshot value (or deleted, if newly created). */
  restoredRefs: string[];
  /** Refs a restore attempt failed for, with git's own error. */
  restoreErrors: Array<{ ref: string; error: string }>;
}

/**
 * Diff `before` vs `after` and restore any ref that changed or was newly
 * created back to its snapshot state. Returns `null` when nothing changed
 * (the common, expected case — most bash calls touch no ref at all).
 */
export function restoreGitEffects(
  cwd: string,
  before: GitEffectSnapshot,
  after: GitEffectSnapshot,
): GitEffectViolation | null {
  const changedRefs: string[] = [];
  const restoredRefs: string[] = [];
  const restoreErrors: Array<{ ref: string; error: string }> = [];

  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of names) {
    const beforeSha = before.refs[name];
    const afterSha = after.refs[name];
    if (beforeSha === afterSha) continue;
    changedRefs.push(name);
    if (beforeSha) {
      const r = git(cwd, ["update-ref", name, beforeSha]);
      if (r.ok) restoredRefs.push(name);
      else restoreErrors.push({ ref: name, error: r.stderr.trim() || "update-ref failed" });
    } else {
      // Newly created — delete it. The commit(s) it pointed at stay
      // reachable via the reflog (HEAD's, or the deleted ref's own, briefly)
      // — nothing is lost, only the thing that made them reachable by NAME.
      const r = git(cwd, ["update-ref", "-d", name]);
      if (r.ok) restoredRefs.push(name);
      else restoreErrors.push({ ref: name, error: r.stderr.trim() || "update-ref -d failed" });
    }
  }

  // HEAD itself — covers a detached-HEAD commit, which moves no NAMED ref
  // `for-each-ref` would report, only what HEAD points at directly.
  if (before.headSha !== after.headSha) {
    changedRefs.push("HEAD");
    if (before.headSha) {
      const r = git(cwd, ["update-ref", "HEAD", before.headSha]);
      if (r.ok) restoredRefs.push("HEAD");
      else restoreErrors.push({ ref: "HEAD", error: r.stderr.trim() || "update-ref HEAD failed" });
    }
  }

  const reflogGrew = after.reflogCount > before.reflogCount;
  const stashChanged = after.stashList !== before.stashList;
  if (changedRefs.length === 0 && !reflogGrew && !stashChanged) return null;

  return { changedRefs, restoredRefs, restoreErrors };
}

export interface EffectGuardHandle {
  /** Re-snapshot and restore. Call exactly once, after the guarded command finishes. */
  finish(): GitEffectViolation | null;
}

/**
 * Begin an effect guard for `cwd`, or return `null` when one is not
 * applicable (not inside a git repo). Callers gate this on
 * `isAutoCommitDisabledByProject()` themselves — see registry.ts's bash tool
 * wiring — so the extra `git` subprocess calls are paid only for a project
 * that opted into the stricter guarantee.
 */
export function beginGitEffectGuard(cwd: string): EffectGuardHandle | null {
  if (!isInsideGitRepo(cwd)) return null;
  const before = snapshotGitEffects(cwd);
  return {
    finish(): GitEffectViolation | null {
      const after = snapshotGitEffects(cwd);
      const violation = restoreGitEffects(cwd, before, after);
      if (violation) {
        logger.error(
          "cli",
          "[git-effect-guard] command created/moved git ref(s) while autoCommit is disabled — restored",
          {
            changedRefs: violation.changedRefs,
            restoredRefs: violation.restoredRefs,
            restoreErrors: violation.restoreErrors,
            cwd,
          },
        );
      }
      return violation;
    },
  };
}

/** Human-readable refusal message for a tool result, given a violation. */
export function effectViolationMessage(violation: GitEffectViolation): string {
  const list = violation.changedRefs.join(", ");
  const base = `autoCommit is disabled for this project: the command created or moved git refs (${list}); they were restored.`;
  if (violation.restoreErrors.length === 0) return base;
  const failed = violation.restoreErrors.map((e) => `${e.ref} (${e.error})`).join(", ");
  return `${base} WARNING: failed to restore: ${failed} — manual cleanup may be needed.`;
}
