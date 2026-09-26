/**
 * src/tools/git-effect-guard.ts
 *
 * Round 3 made the `autoCommit: false` guarantee effect-based (detect a ref
 * change no matter how the command spelled "git", since string parsing an
 * arbitrary shell line is an arms race) — but round 3's AUTO-RESTORE
 * (`update-ref` back to the snapshot, or `-d` on a newly-created ref) was
 * itself destructive (round-4 refuter: it rewrote a benign `checkout`
 * target's tip, reverted a concurrent session's legitimate commit, and left
 * a `stash pop` half-restored).
 *
 * Round 4: DETECT AND REPORT, NEVER MUTATE. This module only ever reads
 * (`for-each-ref`, `rev-parse`, `symbolic-ref`, `reflog show`, `rev-list`) —
 * no `update-ref`, `reset`, or `stash` call exists anywhere in it.
 *
 * Round 5, a cost + correctness pass on round 4's detection:
 *   (a) COST — round 4 ran `git log --all --reflog` (an UNBOUNDED walk of
 *       every ref, every reflog, the whole commit graph) on literally every
 *       guarded call, even a pure `git status`. Redesigned cheap-first: the
 *       snapshot is only `for-each-ref` + `rev-parse HEAD` + `symbolic-ref
 *       HEAD` + a HEAD-only `reflog show` (bounded by HEAD's OWN reflog,
 *       not `--all` — cheap). If before/after are identical on ALL of
 *       those, return immediately: NO history walk of any kind. Only when
 *       something differs does a walk run at all, and even then it is
 *       BOUNDED to the delta: `git rev-list <changed tips> --not <all
 *       before tips>` — this only visits commits reachable from what
 *       changed and NOT already reachable before, never the whole graph.
 *   (b) A commit is classified new-vs-existing PURELY by that reachability
 *       query — never by committer time (round 4's `--since` filter
 *       misclassified a backdated `GIT_COMMITTER_DATE` commit as
 *       "pre-existing" since its clock-time looked old, even though its sha
 *       — content-addressed, so a genuinely new object — could not
 *       possibly have been reachable before it was created).
 *   (c) A DELETED ref (branch or tag) is now reported — round 4 silently
 *       skipped it ("only creating/moving a ref is in scope").
 *   (d) Every ref change is labeled by its REAL action — created / moved /
 *       deleted — not a single blanket "moved" bucket (round 4 called
 *       `git branch bookmark HEAD~1`, which CREATES `bookmark`, a "move").
 *       A ref created or moved to an already-EXISTING commit is still
 *       reported (autoCommit:false means the agent must not touch refs at
 *       all, not just "must not create new commits"), worded precisely:
 *       "created ref X at existing commit Y" / "ref X moved to existing
 *       commit Y". A ref whose new target IS a genuinely new commit is
 *       folded into the "new commit(s) ... appeared under X" wording
 *       instead (covers create-with-new-commit and move-with-new-commit
 *       uniformly — both mean "a new commit became reachable via a name").
 *   The reflog-only case (a commit created then reset back to the SAME
 *   value within one guarded command — refs end up identical, nothing
 *   about them looks different) is still caught: HEAD's OWN reflog COUNT
 *   is part of the cheap before/after comparison, so it alone can trigger
 *   the bounded check even when every ref is back to its original value;
 *   the bounded query then seeds itself with the reflog entries added
 *   since `before` (a bounded `reflog show --format=%H HEAD -n <delta>`,
 *   not a full walk) so the transient commit is still found.
 *
 * On a violation the tool result becomes an error (see
 * `effectViolationMessage`) and it is logged — nothing about the repository
 * is ever touched. `git push` remains a separate, still string-based concern
 * (`detectBlockedGitSubcommand`/registry.ts) — a push cannot be undone once
 * a remote has it, so it must still be caught BEFORE execution.
 */
import { spawnSync } from "node:child_process";
import { logger } from "../utils/logger.js";

// ─── Test-only call instrumentation ────────────────────────────────────────
// Every `git` invocation this module makes is recorded here (never exported
// as anything but a read/reset pair) so a test can assert e.g. "a no-op read
// command triggers zero rev-list/history-walk calls" without needing to mock
// child_process across an ESM boundary.
let _callLog: string[][] = [];
/** Test-only: every `git <args>` invocation made since the last reset. */
export function __getGitCallLogForTests(): string[][] {
  return _callLog.map((a) => [...a]);
}
/** Test-only: clear the call log. */
export function __resetGitCallLogForTests(): void {
  _callLog = [];
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  _callLog.push(args);
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
  /** refname -> objectname (sha), from `for-each-ref` (cheap — no commit-graph walk). Never contains "HEAD". */
  refs: Record<string, string>;
  /** `git rev-parse HEAD` — null with no commits yet. */
  headSha: string | null;
  /** `git symbolic-ref -q HEAD` — the branch HEAD follows, or null when detached. */
  headSymbolic: string | null;
  /** Line count of `git reflog show HEAD` — bounded by HEAD's OWN reflog only (never `--all`), so this is cheap regardless of overall repo size. Used purely as a change-detection signal. */
  reflogCount: number;
}

function forEachRef(cwd: string): Record<string, string> {
  const refs: Record<string, string> = {};
  const out = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  if (out.ok) {
    for (const line of out.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.lastIndexOf(" ");
      if (idx < 0) continue;
      refs[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return refs;
}

function headReflogCount(cwd: string): number {
  const out = git(cwd, ["reflog", "show", "HEAD"]);
  if (!out.ok) return 0;
  return out.stdout.split("\n").filter((l) => l.trim()).length;
}

/** Cheap snapshot: for-each-ref + HEAD sha/symbolic-target + HEAD's own reflog count. Never throws, never walks the commit graph. */
export function snapshotGitEffects(cwd: string): GitEffectSnapshot {
  const refs = forEachRef(cwd);
  const headOut = git(cwd, ["rev-parse", "HEAD"]);
  const headSha = headOut.ok && headOut.stdout.trim() ? headOut.stdout.trim() : null;
  const symOut = git(cwd, ["symbolic-ref", "-q", "HEAD"]);
  const headSymbolic = symOut.ok && symOut.stdout.trim() ? symOut.stdout.trim() : null;
  const reflogCount = headReflogCount(cwd);
  return { refs, headSha, headSymbolic, reflogCount };
}

export type RefActionKind = "created" | "moved" | "deleted";

export interface RefAction {
  ref: string;
  kind: RefActionKind;
  /** Present for moved/deleted — the ref's value before this window. */
  fromSha?: string;
  /** Present for created/moved — the ref's value after this window. */
  toSha?: string;
  /** Present for created/moved — true when `toSha` is a commit that did NOT exist reachable-before this window (a genuinely new commit), false when it was already reachable (a reset/force-move/re-tag to something old, or `git branch x HEAD~1`). */
  toIsNewCommit?: boolean;
}

export interface GitEffectViolation {
  /** Every ref that changed, precisely labeled. */
  refActions: RefAction[];
  /** Every genuinely new commit sha found this window — including one with no CURRENT live ref pointing at it (a detached-HEAD commit, or the "commit then reset back" reflog-only case). */
  newCommits: string[];
}

/**
 * Compare `before` (captured pre-command) against a FRESH snapshot and
 * report — never mutate — any violation. Returns `null` when nothing
 * happened. The overwhelmingly common case (a read-only command, or any
 * command that never touches a ref or HEAD) is detected from the cheap
 * snapshot alone, with ZERO further git calls.
 */
export function detectGitEffectViolation(cwd: string, before: GitEffectSnapshot): GitEffectViolation | null {
  const after = snapshotGitEffects(cwd);

  const refNames = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  const changedRefNames: string[] = [];
  for (const name of refNames) {
    if (before.refs[name] !== after.refs[name]) changedRefNames.push(name);
  }
  const reflogChanged = after.reflogCount !== before.reflogCount;

  // FAST PATH — nothing named changed, HEAD's own reflog didn't grow either:
  // no history walk of any kind, not even a bounded one.
  if (changedRefNames.length === 0 && !reflogChanged) {
    return null;
  }

  // Something changed — a BOUNDED reachability query decides new-vs-existing,
  // never committer time. Seed it with every tip that could plausibly be new:
  // the after-value of every changed ref, HEAD's current value (covers a
  // detached-HEAD commit — no named ref backs it), and — for the reflog-only
  // case — the reflog entries added since `before` (bounded to exactly the
  // delta count, not a full walk).
  const beforeTips = [...new Set([...Object.values(before.refs), before.headSha].filter((x): x is string => !!x))];
  const candidateTips = new Set<string>();
  for (const name of changedRefNames) {
    const v = after.refs[name];
    if (v) candidateTips.add(v);
  }
  if (after.headSha) candidateTips.add(after.headSha);
  if (reflogChanged && after.reflogCount > before.reflogCount) {
    const delta = after.reflogCount - before.reflogCount;
    const deltaOut = git(cwd, ["reflog", "show", "--format=%H", "HEAD", "-n", String(delta)]);
    if (deltaOut.ok) {
      for (const line of deltaOut.stdout.split("\n")) {
        const sha = line.trim();
        if (sha) candidateTips.add(sha);
      }
    }
  }

  const newCommitSet = new Set<string>();
  if (candidateTips.size > 0) {
    const args = ["rev-list", ...candidateTips];
    if (beforeTips.length > 0) args.push("--not", ...beforeTips);
    const rl = git(cwd, args);
    if (rl.ok) {
      for (const line of rl.stdout.split("\n")) {
        const sha = line.trim();
        if (sha) newCommitSet.add(sha);
      }
    }
  }

  const refActions: RefAction[] = [];
  for (const name of changedRefNames) {
    const b = before.refs[name];
    const a = after.refs[name];
    if (a === undefined) {
      refActions.push({ ref: name, kind: "deleted", fromSha: b });
    } else if (b === undefined) {
      refActions.push({ ref: name, kind: "created", toSha: a, toIsNewCommit: newCommitSet.has(a) });
    } else {
      refActions.push({ ref: name, kind: "moved", fromSha: b, toSha: a, toIsNewCommit: newCommitSet.has(a) });
    }
  }

  const newCommits = [...newCommitSet];
  if (refActions.length === 0 && newCommits.length === 0) return null;
  return { refActions, newCommits };
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
          "[git-effect-guard] command created, moved, or deleted git ref(s) while autoCommit is disabled — reported, NOT reverted",
          {
            refActions: violation.refActions,
            newCommits: violation.newCommits,
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
  const newCommitRefs = new Map<string, string[]>();
  for (const a of violation.refActions) {
    if (a.toIsNewCommit && a.toSha) {
      const list = newCommitRefs.get(a.toSha) ?? [];
      list.push(a.ref);
      newCommitRefs.set(a.toSha, list);
    }
  }

  const clauses: string[] = [];

  if (violation.newCommits.length > 0) {
    const parts = violation.newCommits.map((sha) => {
      const refs = newCommitRefs.get(sha);
      const label = refs && refs.length > 0 ? refs.join(", ") : "(no current ref)";
      return `${sha.slice(0, 12)} under ${label}`;
    });
    clauses.push(`new commit(s) ${parts.join(", ")} appeared`);
  }

  const createdExisting = violation.refActions.filter((a) => a.kind === "created" && !a.toIsNewCommit);
  if (createdExisting.length > 0) {
    const list = createdExisting.map((a) => `${a.ref} (at existing commit ${a.toSha?.slice(0, 12)})`).join(", ");
    clauses.push(`ref(s) ${list} created`);
  }

  const movedExisting = violation.refActions.filter((a) => a.kind === "moved" && !a.toIsNewCommit);
  if (movedExisting.length > 0) {
    const list = movedExisting
      .map((a) => `${a.ref} (to existing commit ${a.toSha?.slice(0, 12)}, was ${a.fromSha?.slice(0, 12)})`)
      .join(", ");
    clauses.push(`ref(s) ${list} moved`);
  }

  const deleted = violation.refActions.filter((a) => a.kind === "deleted");
  if (deleted.length > 0) {
    const list = deleted.map((a) => `${a.ref} (was ${a.fromSha?.slice(0, 12)})`).join(", ");
    clauses.push(`ref(s) ${list} deleted`);
  }

  return (
    `autoCommit is disabled for this project: ${clauses.join("; ")} while this command ran; nothing was changed; ` +
    "if it was yours, undo it (e.g. git reset), if it may be another session's, leave it"
  );
}
