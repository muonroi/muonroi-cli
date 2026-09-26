/**
 * src/tools/git-effect-guard.ts
 *
 * ─── CONTRACT ───────────────────────────────────────────────────────────────
 * This module is a detect-and-report backstop for LASTING effects of ONE
 * guarded tool call on the guarded repository. It reports, and never
 * mutates:
 *   - any named ref (branch, tag, remote-tracking ref, `refs/stash`, ...)
 *     created, moved, or deleted during the guarded window;
 *   - any commit that becomes reachable from a ref, OR that appears in the
 *     guarded worktree's OWN HEAD reflog, during the guarded window.
 *
 * It is NOT a full audit of every git operation the command performed, and
 * it does not observe the command's transient/intermediate state — only the
 * LASTING difference between a snapshot taken immediately before the
 * command and one taken immediately after. A sequence that nets to zero —
 * leaves no ref changed, created, or deleted, and adds no entry to the
 * guarded worktree's own HEAD reflog — is OUT OF SCOPE by design, for three
 * known reasons (each pinned by a test asserting the CURRENT, limited
 * behaviour, so a future change is deliberate, not an accidental discovery):
 *
 *   1. PER-WORKTREE REFLOG — a commit created and reset back to its
 *      original value inside a DIFFERENT linked worktree of the same
 *      repository is invisible: each worktree has its OWN HEAD and its OWN
 *      HEAD reflog (`.git/worktrees/<name>/logs/HEAD`); this module only
 *      ever reads the reflog of the worktree it was started in.
 *   2. NO LASTING REPO EFFECT — `git commit-tree` (creates a commit object
 *      without touching any ref or reflog) followed by `git update-ref
 *      refs/x <sha>` then `git update-ref -d refs/x` in the same call nets
 *      to zero: no ref differs between the before/after snapshot, and no
 *      HEAD reflog entry was written (update-ref on a non-HEAD ref never
 *      touches HEAD's reflog). The commit object is left dangling in the
 *      object store (recoverable via `git fsck --unreachable` until gc),
 *      but nothing observable through refs or the HEAD reflog records it
 *      ever existed.
 *   3. REFLOG DISABLED — with `core.logAllRefUpdates=false`, or a repo
 *      state where `.git/logs/HEAD` was never created, a commit-then-
 *      reset-back sequence writes no reflog entries at all: this module's
 *      ENTIRE detection mechanism for a "refs end up identical" sequence is
 *      the HEAD reflog, so with reflogging off there is no signal to read.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Round 3 made the guarantee effect-based (detect a ref change no matter how
 * the command spelled "git", since string parsing an arbitrary shell line is
 * an arms race) — but round 3's AUTO-RESTORE (`update-ref` back to the
 * snapshot, or `-d` on a newly-created ref) was itself destructive (round-4
 * refuter: it rewrote a benign `checkout` target's tip, reverted a
 * concurrent session's legitimate commit, and left a `stash pop`
 * half-restored).
 *
 * Round 4: DETECT AND REPORT, NEVER MUTATE. This module only ever reads
 * (`for-each-ref`, `rev-parse`, `reflog show`, `rev-list`) — no
 * `update-ref`, `reset`, or `stash` call exists anywhere in it.
 *
 * Round 5, a cost + correctness pass on round 4's detection:
 *   (a) COST — round 4 ran `git log --all --reflog` (an UNBOUNDED walk of
 *       every ref, every reflog, the whole commit graph) on literally every
 *       guarded call, even a pure `git status`. Redesigned cheap-first: the
 *       snapshot is only `for-each-ref` + `rev-parse HEAD` + a HEAD-only
 *       `reflog show` (bounded by HEAD's OWN reflog, not `--all` — cheap).
 *       If before/after are identical on ALL of those, return immediately:
 *       NO history walk of any kind. Only when something differs does a
 *       walk run at all, and even then it is BOUNDED to the delta: `git
 *       rev-list <changed tips> --not <all before tips>` — this only visits
 *       commits reachable from what changed and NOT already reachable
 *       before, never the whole graph.
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
 * Round 6, a further cost pass (round 4's detection logic itself confirmed
 * correct by a refuter) — `for-each-ref` is O(ref count): measured ~84ms on
 * a synthetic 5000-loose-ref repo, ~10ms once packed, and round 5 still
 * called it TWICE per guarded call (before AND after) even for a no-op read.
 * `computeRefsFingerprint` stands in for a full `for-each-ref` on the AFTER
 * side: fs `stat()` of `packed-refs` plus every loose ref file under
 * `<git-common-dir>/refs` (mtime+size+inode each — a directory-mtime-only
 * check would miss a rewrite that reuses an existing filename; measured that
 * THIS filesystem does bump the parent dir's mtime on such a rename anyway,
 * but that is not a portable guarantee, so every file is stat'd). If the
 * fingerprint (plus HEAD/reflog, already cheap) is unchanged, `for-each-ref`
 * is skipped entirely on the after side — it still runs once, unconditionally,
 * on the BEFORE side (the real ref values have to be captured with something
 * before the command can run; there is no way to reconstruct them
 * afterward). Measured on the same 5000-ref repo: fingerprint ~28ms (loose)
 * / ~4ms (packed) including the one `git rev-parse --git-dir
 * --git-common-dir` call needed to locate the paths — cheaper than
 * `for-each-ref` in both states, so the no-op overhead drops from ~2×
 * for-each-ref to 1× for-each-ref + 2× fingerprint. `--git-dir`/
 * `--git-common-dir` (not a hardcoded `.git/`) is what makes this correct
 * from inside a linked worktree, whose refs/ live in the COMMON dir but
 * whose own HEAD/logs do not. The dead `headSymbolic` field (computed by
 * round 4/5, never read by any check) is removed.
 *
 * Round 7 (small): the round-6 fingerprint only ever walked `<common-dir>/
 * refs` — a linked worktree's OWN per-worktree refs (`refs/bisect/*` from
 * `git bisect`, `refs/worktree/*`) live under `<git-dir>/refs` instead and
 * were never scanned (only caught by incidental `packed-refs` churn
 * elsewhere). `computeRefsFingerprint` now also walks `<git-dir>/refs` +
 * stats `<git-dir>/HEAD`/`logs/HEAD` whenever `gitDir !== commonDir`. Also
 * added a defensive (unmeasured — this box runs git 2.39.5, which predates
 * it) fallback for the reftable ref-storage format (git >= 2.44): when a
 * `reftable/` directory exists under `commonDir`, the fingerprint fast path
 * is skipped entirely (always mismatches) rather than risk fingerprinting
 * a format not characterized here.
 *
 * On a violation the tool result becomes an error (see
 * `effectViolationMessage`) and it is logged — nothing about the repository
 * is ever touched. `git push` remains a separate, still string-based concern
 * (`detectBlockedGitSubcommand`/registry.ts) — a push cannot be undone once
 * a remote has it, so it must still be caught BEFORE execution.
 */
import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
  /** refname -> objectname (sha), from `for-each-ref` (no commit-graph walk, but O(ref count) — see `refsFingerprint`). Never contains "HEAD". */
  refs: Record<string, string>;
  /** Cheap fs-only stand-in for "would for-each-ref's output differ" — see `computeRefsFingerprint`. */
  refsFingerprint: string;
  /** `git rev-parse HEAD` — null with no commits yet. */
  headSha: string | null;
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

interface GitPaths {
  /** `git rev-parse --git-dir` — per-WORKTREE (HEAD, logs/HEAD live here). */
  gitDir: string;
  /** `git rev-parse --git-common-dir` — shared across all worktrees of this repo (refs/, packed-refs live here). */
  commonDir: string;
}

/**
 * Resolve both directories in ONE call (each on its own stdout line). Using
 * `--git-common-dir` (not a hardcoded `.git/`) is what makes
 * `computeRefsFingerprint` correct from inside a linked worktree — its refs
 * live in the common dir, shared with every other worktree of the same
 * repository. Returns `null` on any failure; callers degrade to "always
 * fingerprint-mismatch" (falls through to a real `for-each-ref`), never to a
 * missed violation.
 */
function resolveGitPaths(cwd: string): GitPaths | null {
  const out = git(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (!out.ok) return null;
  const lines = out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const gitDir = isAbsolute(lines[0]) ? lines[0] : join(cwd, lines[0]);
  const commonDir = isAbsolute(lines[1]) ? lines[1] : join(cwd, lines[1]);
  return { gitDir, commonDir };
}

/** All (mtime, size, inode) entries for every regular file under `root`, recursively. Never throws — an unreadable dir/file is just skipped (see the fingerprint's own doc comment on why that's safe). */
function statTreeEntries(root: string): string[] {
  const entries: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string; // length just checked above
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const s = statSync(full, { bigint: true });
        entries.push(`${full}:${s.mtimeNs}:${s.size}:${s.ino}`);
      } catch {
        /* raced with a delete mid-walk — see the fingerprint's doc comment */
      }
    }
  }
  return entries;
}

/**
 * Cheap fs-only stand-in for "would `git for-each-ref` print something
 * different now" — no git subprocess, just `stat()`. Combines `packed-refs`'
 * own (mtime, size, inode) with the same triple for every LOOSE file under
 * `<common-dir>/refs` (sorted, so traversal order never spuriously changes
 * the result). A directory-mtime-only check would be cheaper still, but was
 * measured to be unsafe to rely on in general (see the round-6 header
 * comment) — every file is stat'd individually so a rewrite that reuses an
 * existing filename (`git branch -f` on an existing branch) is never missed
 * regardless of filesystem rename semantics.
 *
 * Round 7 fix: PER-WORKTREE refs (`refs/bisect/*`, `refs/worktree/*`, ...)
 * live under `<git-dir>/refs` in a LINKED worktree, not `<common-dir>/refs` —
 * a round-6 refuter found `git bisect start/bad/good` run inside a linked
 * worktree went undetected (only caught by incidental packed-refs churn).
 * When `gitDir !== commonDir` this now also walks `<git-dir>/refs` and
 * stats `<git-dir>/HEAD` + `<git-dir>/logs/HEAD` (the per-worktree files —
 * redundant with the separate `rev-parse HEAD`/`reflog show HEAD` git calls
 * for the common case, but folding them into the SAME fingerprint this
 * function returns keeps it self-contained as "everything for-each-ref-
 * adjacent that could differ").
 *
 * Round 7 also fix: reftable (git >= 2.44) stores every ref in a compacted,
 * rotating table format (`<common-dir>/reftable/`) this function does not
 * (yet) know how to cheaply and CORRECTLY fingerprint — a table can be
 * rewritten/compacted in ways not characterized here, and getting this
 * wrong risks a false "unchanged". Simpler and safe: when a `reftable`
 * directory exists, skip the fingerprint fast path ENTIRELY — this returns
 * a fresh, never-repeating value every single call, so `before !==
 * after` always, and `for-each-ref` always runs for real. (This box runs
 * git 2.39.5, which predates reftable, so this branch could not be
 * exercised directly — it is a defensive default, not a measured cost.)
 *
 * A mismatch only ever means "go check for real" (`for-each-ref` runs next);
 * it is never itself treated as proof of what changed. So a stat() racing a
 * concurrent ref write and losing (file vanished mid-walk, say) can only
 * cause an unnecessary `for-each-ref` call — never a missed violation.
 */
function computeRefsFingerprint(paths: GitPaths | null): string {
  if (!paths) return "";
  try {
    if (statSync(join(paths.commonDir, "reftable")).isDirectory()) {
      return `reftable-unsupported:${Date.now()}:${Math.random()}`;
    }
  } catch {
    /* no reftable dir — the normal, files-backend case */
  }
  const parts: string[] = [];
  try {
    const s = statSync(join(paths.commonDir, "packed-refs"), { bigint: true });
    parts.push(`P:${s.mtimeNs}:${s.size}:${s.ino}`);
  } catch {
    /* no packed-refs is a valid, stable state — absence needs no entry */
  }
  const entries = statTreeEntries(join(paths.commonDir, "refs"));
  if (paths.gitDir !== paths.commonDir) {
    // Linked worktree — its OWN refs/ (bisect, worktree, ...) and its own
    // HEAD/logs/HEAD live here, not under commonDir.
    entries.push(...statTreeEntries(join(paths.gitDir, "refs")));
    try {
      const s = statSync(join(paths.gitDir, "HEAD"), { bigint: true });
      parts.push(`H:${s.mtimeNs}:${s.size}:${s.ino}`);
    } catch {
      /* HEAD always exists in a real worktree; absence would mean a race — safe to ignore, see doc comment */
    }
    try {
      const s = statSync(join(paths.gitDir, "logs", "HEAD"), { bigint: true });
      parts.push(`L:${s.mtimeNs}:${s.size}:${s.ino}`);
    } catch {
      /* no logs/HEAD is valid (reflog disabled/never created — see limitation 3) */
    }
  }
  entries.sort();
  parts.push(...entries);
  return parts.join("|");
}

/** Full snapshot: for-each-ref + its cheap fingerprint + HEAD sha + HEAD's own reflog count. Never throws, never walks the commit graph. */
export function snapshotGitEffects(cwd: string): GitEffectSnapshot {
  const refs = forEachRef(cwd);
  const refsFingerprint = computeRefsFingerprint(resolveGitPaths(cwd));
  const headOut = git(cwd, ["rev-parse", "HEAD"]);
  const headSha = headOut.ok && headOut.stdout.trim() ? headOut.stdout.trim() : null;
  const reflogCount = headReflogCount(cwd);
  return { refs, refsFingerprint, headSha, reflogCount };
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
 * Compare `before` (captured pre-command) against a FRESH read and report —
 * never mutate — any violation. Returns `null` when nothing happened. The
 * overwhelmingly common case (a read-only command, or any command that
 * never touches a ref or HEAD) is detected from the cheap fingerprint +
 * HEAD sha + HEAD reflog count alone — `for-each-ref` is NOT called again on
 * this (after) side at all when nothing changed; it only ever runs
 * unconditionally once, on the BEFORE side (`snapshotGitEffects`), since the
 * real before-values have to be captured with something before the command
 * runs — there is no way to reconstruct them afterward.
 */
export function detectGitEffectViolation(cwd: string, before: GitEffectSnapshot): GitEffectViolation | null {
  const paths = resolveGitPaths(cwd);
  const afterFingerprint = computeRefsFingerprint(paths);
  const headOut = git(cwd, ["rev-parse", "HEAD"]);
  const afterHeadSha = headOut.ok && headOut.stdout.trim() ? headOut.stdout.trim() : null;
  const afterReflogCount = headReflogCount(cwd);

  const reflogChanged = afterReflogCount !== before.reflogCount;
  const refsMaybeChanged = afterFingerprint !== before.refsFingerprint;

  // FAST PATH — the cheap fingerprint says for-each-ref would print nothing
  // different, and HEAD's own reflog didn't grow either: for-each-ref is
  // never called on this side, and no history walk of any kind runs.
  if (!refsMaybeChanged && !reflogChanged) {
    return null;
  }

  // The fingerprint (or reflog count) differs — get the REAL after-state now.
  const afterRefs = forEachRef(cwd);

  const refNames = new Set([...Object.keys(before.refs), ...Object.keys(afterRefs)]);
  const changedRefNames: string[] = [];
  for (const name of refNames) {
    if (before.refs[name] !== afterRefs[name]) changedRefNames.push(name);
  }

  // A fingerprint mismatch is only ever a "go check for real" signal, never
  // proof by itself — e.g. a loose ref rewritten to the SAME value still
  // touches its file's mtime/inode. If the real diff finds nothing named
  // changed and the reflog didn't grow, there is still nothing to report.
  if (changedRefNames.length === 0 && !reflogChanged) {
    return null;
  }

  // Something REALLY changed — a BOUNDED reachability query decides
  // new-vs-existing, never committer time. Seed it with every tip that
  // could plausibly be new: the after-value of every changed ref, HEAD's
  // current value (covers a detached-HEAD commit — no named ref backs it),
  // and — for the reflog-only case — the reflog entries added since
  // `before` (bounded to exactly the delta count, not a full walk).
  const beforeTips = [...new Set([...Object.values(before.refs), before.headSha].filter((x): x is string => !!x))];
  const candidateTips = new Set<string>();
  for (const name of changedRefNames) {
    const v = afterRefs[name];
    if (v) candidateTips.add(v);
  }
  if (afterHeadSha) candidateTips.add(afterHeadSha);
  if (reflogChanged && afterReflogCount > before.reflogCount) {
    const delta = afterReflogCount - before.reflogCount;
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
    const a = afterRefs[name];
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
