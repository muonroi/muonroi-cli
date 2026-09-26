/**
 * src/tools/git-effect-guard.ts
 *
 * Round 3 made the `autoCommit: false` guarantee effect-based (detect a ref
 * change no matter how the command spelled "git", since string parsing an
 * arbitrary shell line is an arms race) — but round 3's AUTO-RESTORE
 * (`update-ref` back to the snapshot, or `-d` on a newly-created ref) was
 * itself destructive, and a round-4 refuter broke it three ways:
 *   1. HIGH — a benign `git checkout other` made the guard run
 *      `update-ref HEAD <old-sha>` through the symbolic HEAD, which
 *      rewrote `other`'s OWN tip and orphaned its commits. Repro'd.
 *   2. HIGH — another session's legitimate commit landing in the same
 *      window got silently reverted — this guard has no way to know a ref
 *      change was ITS command's doing versus a concurrent session's.
 *   3. MEDIUM — `stash pop` (apply + drop) was left half-restored.
 *
 * Round 4: DETECT AND REPORT, NEVER MUTATE REFS. This module now only ever
 * reads (`for-each-ref`, `symbolic-ref`, `log`) — no `update-ref`, `reset`,
 * or `stash` call exists anywhere in it. A violation is:
 *   - a NEW commit object created during the guarded window (found via
 *     `git log --all --reflog --since=<window start>`, so it catches a
 *     commit on any branch, a detached HEAD, or one only reachable via
 *     reflog — filtered against a full "reachable before" snapshot so a
 *     commit that already existed is never misclassified as new); or
 *   - an EXISTING (already-reachable) commit that a NAMED ref (`for-each-ref`
 *     — branch, tag, remote-tracking, `refs/stash`) now points to instead of
 *     its snapshot value (`git reset`, `git update-ref`, a force-moved tag).
 * A plain `git checkout <branch>` is NEVER a violation on its own: HEAD is
 * symbolic and not enumerated by `for-each-ref`, so switching which branch
 * HEAD follows changes no named ref's OWN recorded value — this needs no
 * special-casing, it falls out of only ever diffing `for-each-ref` entries.
 *
 * On a violation the tool result becomes an error (see
 * `effectViolationMessage`) and it is logged — nothing about the repository
 * is ever touched. `git push` remains a separate, still string-based concern
 * (`detectBlockedGitSubcommand`/registry.ts) — a push cannot be undone once
 * a remote has it, so it must still be caught BEFORE execution.
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
  /** refname -> objectname (sha), from `for-each-ref`. Includes `refs/stash` when present. Never contains "HEAD" — for-each-ref doesn't enumerate it, which is exactly what makes a plain branch-switching checkout a non-event here. */
  refs: Record<string, string>;
  /** Every commit sha reachable from any ref OR reflog entry, at snapshot time (`git log --all --reflog --format=%H`). Used to tell a genuinely NEW commit apart from an old one a ref merely started pointing at again. */
  reachable: Set<string>;
  /** Unix seconds at snapshot time — the window start for the post-command `--since` query. */
  startEpochSec: number;
}

/** Snapshot every ref + the full reachable-commit set + the window start. Never throws. Read-only. */
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
  const reachable = new Set<string>();
  const logOut = git(cwd, ["log", "--all", "--reflog", "--format=%H"]);
  if (logOut.ok) {
    for (const line of logOut.stdout.split("\n")) {
      const sha = line.trim();
      if (sha) reachable.add(sha);
    }
  }
  return { refs, reachable, startEpochSec: Math.floor(Date.now() / 1000) };
}

export interface GitEffectViolation {
  /** Commit shas created during the guarded window (not reachable before it started). */
  newCommits: string[];
  /** Named refs (for-each-ref entries) that now point at one of `newCommits`. */
  refsWithNewCommits: string[];
  /** Named refs whose value changed to something that already existed before (reset/force-move/re-tag), NOT a new commit. */
  movedToExistingRefs: string[];
}

/**
 * Compare `before` (captured pre-command) against a FRESH snapshot and
 * report — never mutate — any violation. Returns `null` when nothing
 * happened (the overwhelmingly common case: most commands touch no ref and
 * create no commit at all).
 */
export function detectGitEffectViolation(cwd: string, before: GitEffectSnapshot): GitEffectViolation | null {
  const after = snapshotGitEffects(cwd);

  // 1. New commit objects: anything with committer-time >= the window start
  // that was NOT already reachable before. `--since` narrows the candidate
  // set (cheap); the `before.reachable` check is what actually decides "new"
  // — a same-second coincidence, or a commit whose date was set explicitly,
  // is still correctly excluded if its sha was already present beforehand.
  const newCommits: string[] = [];
  const sinceOut = git(cwd, ["log", "--all", "--reflog", "--format=%H %ct", `--since=@${before.startEpochSec - 1}`]);
  if (sinceOut.ok) {
    for (const line of sinceOut.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.lastIndexOf(" ");
      if (idx < 0) continue;
      const sha = trimmed.slice(0, idx);
      const ct = Number(trimmed.slice(idx + 1));
      if (Number.isFinite(ct) && ct >= before.startEpochSec && !before.reachable.has(sha)) {
        newCommits.push(sha);
      }
    }
  }
  const newCommitSet = new Set(newCommits);

  // 2. Named-ref diff. A ref pointing at a NEW commit is reported alongside
  // it; a ref pointing at something ELSE that changed (and is not new) moved
  // to an already-existing commit — a reset, a force-push-style local
  // update-ref, a tag recreated at an old sha, etc. HEAD is never a key
  // here (for-each-ref doesn't enumerate it) — a plain `checkout <branch>`
  // therefore produces zero entries in this loop by construction.
  const refsWithNewCommits: string[] = [];
  const movedToExistingRefs: string[] = [];
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of names) {
    const beforeSha = before.refs[name];
    const afterSha = after.refs[name];
    if (beforeSha === afterSha) continue;
    if (afterSha && newCommitSet.has(afterSha)) {
      refsWithNewCommits.push(name);
    } else if (afterSha) {
      // Changed (or newly created) but points at something that already
      // existed prior to this window — a pure ref move, not a new commit.
      movedToExistingRefs.push(name);
    }
    // A ref that DISAPPEARED (afterSha undefined) is not itself flagged —
    // only creating/moving a ref is in scope here.
  }

  if (newCommits.length === 0 && movedToExistingRefs.length === 0) return null;

  return { newCommits, refsWithNewCommits, movedToExistingRefs };
}

export interface EffectGuardHandle {
  /** Re-snapshot and detect (read-only). Call exactly once, after the guarded command finishes. */
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
      const violation = detectGitEffectViolation(cwd, before);
      if (violation) {
        logger.error(
          "cli",
          "[git-effect-guard] command created or moved git ref(s) while autoCommit is disabled — reported, NOT reverted",
          {
            newCommits: violation.newCommits,
            refsWithNewCommits: violation.refsWithNewCommits,
            movedToExistingRefs: violation.movedToExistingRefs,
            cwd,
          },
        );
      }
      return violation;
    },
  };
}

/** Human-readable message for a tool result, given a violation. Never implies anything was undone. */
export function effectViolationMessage(violation: GitEffectViolation): string {
  const clauses: string[] = [];
  if (violation.newCommits.length > 0) {
    const shas = violation.newCommits.map((s) => s.slice(0, 12)).join(", ");
    const refs = violation.refsWithNewCommits.length > 0 ? violation.refsWithNewCommits.join(", ") : "(no current ref)";
    clauses.push(`new commit(s) ${shas} appeared under ${refs}`);
  }
  if (violation.movedToExistingRefs.length > 0) {
    clauses.push(`ref(s) ${violation.movedToExistingRefs.join(", ")} moved to a different, pre-existing commit`);
  }
  return (
    `autoCommit is disabled for this project: ${clauses.join("; ")} while this command ran; nothing was changed; ` +
    "if it was yours, undo it (e.g. git reset), if it may be another session's, leave it"
  );
}
