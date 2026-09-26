/**
 * Round 4 — round 3's auto-restore was ITSELF destructive: a refuter found
 * it rewrote a branch's tip via a benign `git checkout other` (update-ref
 * HEAD through the symbolic ref moved `other`, not just the local HEAD
 * pointer), reverted another session's concurrent legitimate commit, and
 * left a `stash pop` half-restored.
 *
 * Round 5 — a cost + correctness pass on round 4's DETECTION (never-mutate
 * itself confirmed clean by a refuter):
 *   (a) round 4 ran `git log --all --reflog` (unbounded) on every guarded
 *       call, even a no-op read. Now cheap-first: for-each-ref + HEAD sha/
 *       symbolic-ref + a HEAD-only `reflog show` (bounded to HEAD's own
 *       reflog) before/after; identical -> zero further git calls at all.
 *       Only on a real difference does a BOUNDED `rev-list <tips> --not
 *       <before-tips>` run.
 *   (b) new-vs-existing is decided by that reachability query alone, never
 *       by committer time (fixes a backdated `GIT_COMMITTER_DATE` commit
 *       being misclassified as "moved to a pre-existing commit").
 *   (c) a ref DELETION (branch -D / tag -d) is now reported — round 4
 *       silently skipped it.
 *   (d) every ref change is labeled by its real action — created / moved /
 *       deleted (round 4 called `git branch bookmark HEAD~1`, which
 *       CREATES a ref, "moved").
 *
 * Round 6 — a further cost pass, plus writing the guard's CONTRACT down
 * explicitly (see the module's own header comment for the full text): it is
 * a detect-and-report backstop for LASTING effects on the GUARDED
 * repository — a net-zero sequence that leaves no ref change and no entry
 * in the guarded worktree's OWN HEAD reflog is OUT OF SCOPE by design, for
 * three named reasons. H1/H2/H3 below each PIN that documented limitation
 * (assert the CURRENT `null` result) rather than leaving it a silent gap —
 * a future change in behaviour has to edit these tests deliberately.
 *   - COST: `for-each-ref` is O(ref count) (measured ~84ms at 5000 loose
 *     refs, ~10ms packed) and used to run twice per guarded call even for a
 *     no-op. A cheap fs-only fingerprint (stat of packed-refs + every loose
 *     ref file) now gates the AFTER-side call; measured cheaper than
 *     for-each-ref in both states (~28ms loose / ~4ms packed, including the
 *     one `git rev-parse --git-dir --git-common-dir` needed to locate the
 *     paths correctly from inside a linked worktree).
 *
 * This file tests `git-effect-guard.ts` directly — no `update-ref`/`reset`/
 * `stash` call exists anywhere in the module (grepped below as a structural
 * guard against regressing back to round 3's design), and every case here
 * asserts the repository's ACTUAL state is exactly what the raw command
 * itself produced, never anything extra.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync as fsReadFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __getGitCallLogForTests,
  __resetGitCallLogForTests,
  beginGitEffectGuard,
  effectViolationMessage,
  isInsideGitRepo,
} from "../git-effect-guard.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run `command` through a real shell in `cwd`, the same way BashTool does — never throws. */
function runShell(cwd: string, command: string, env?: Record<string, string>): { ok: boolean } {
  try {
    execSync(command, { cwd, stdio: "pipe", env: env ? { ...process.env, ...env } : process.env });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe("git-effect-guard — detect and report, never mutate (round 4/5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), "git-effect-guard-unit-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    git(dir, ["branch", "other"]);
    __resetGitCallLogForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function headSha(): string {
    return git(dir, ["rev-parse", "HEAD"]);
  }
  function refSha(name: string): string {
    return git(dir, ["rev-parse", name]);
  }

  it("STRUCTURAL GUARD: the module never calls update-ref, reset, or stash on the repo", () => {
    const src = fsReadFileSync(path.join(import.meta.dirname, "..", "git-effect-guard.ts"), "utf8");
    // Strip comments first — the module's OWN doc comments describe round 3's
    // now-removed `update-ref`/`reset` restore calls for context, in prose
    // (backtick-quoted, not array-literal call syntax), which would otherwise
    // false-fail this exact check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\[["'`]update-ref["'`]/);
    expect(code).not.toMatch(/\[["'`]reset["'`]/);
    expect(code).not.toMatch(/\[["'`]stash["'`]/);
  });

  it("COST FIX: a no-op read command triggers ZERO rev-list / history-walk calls", () => {
    const guard = beginGitEffectGuard(dir);
    __resetGitCallLogForTests(); // only count calls made by finish()'s detection, not begin()'s snapshot
    runShell(dir, "git log --oneline -1");
    const violation = guard?.finish() ?? null;
    expect(violation).toBeNull();

    const calls = __getGitCallLogForTests();
    const subcommands = calls.map((a) => a[0]);
    expect(subcommands).not.toContain("rev-list");
    // for-each-ref / rev-parse / symbolic-ref / reflog show ARE expected —
    // those are the cheap before/after snapshot, not a history walk.
    expect(subcommands.every((c) => ["for-each-ref", "rev-parse", "symbolic-ref", "reflog"].includes(c))).toBe(true);
  });

  it("COST FIX: `git status` (also a no-op) triggers zero rev-list calls", () => {
    const guard = beginGitEffectGuard(dir);
    __resetGitCallLogForTests();
    runShell(dir, "git status");
    expect(guard?.finish() ?? null).toBeNull();
    expect(__getGitCallLogForTests().some((a) => a[0] === "rev-list")).toBe(false);
  });

  it("HIGH FIX: `git checkout other` reports NO violation and moves no ref at all", () => {
    const otherBefore = refSha("other");
    const masterBefore = refSha("master");

    const guard = beginGitEffectGuard(dir);
    const ran = runShell(dir, "git checkout other");
    expect(ran.ok).toBe(true);
    const violation = guard?.finish() ?? null;

    expect(violation).toBeNull();
    // The exact bug: round 3's restore rewrote `other`'s tip via `update-ref
    // HEAD <old-sha>` (HEAD is now symbolically refs/heads/other). Prove
    // BOTH branch tips are untouched, not just that HEAD "looks fine".
    expect(refSha("other")).toBe(otherBefore);
    expect(refSha("master")).toBe(masterBefore);
    git(dir, ["checkout", "-q", "master"]);
  });

  it("commit via a script file: violation reported, refs left exactly as the script made them (untouched by the guard)", () => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "sneaky.sh"), '#!/bin/sh\ngit commit -am "sneaky via script file"\n');

    const guard = beginGitEffectGuard(dir);
    runShell(dir, "sh sneaky.sh");
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    expect(violation?.newCommits.length).toBe(1);
    const action = violation?.refActions.find((a) => a.ref === "refs/heads/master");
    expect(action?.kind).toBe("moved");
    expect(action?.toIsNewCommit).toBe(true);
    // NEVER reverted — the new commit is still exactly there.
    expect(headSha()).toBe(violation?.newCommits[0]);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("sneaky via script file");
  });

  it("HIGH FIX: a CONCURRENT commit from another process during the window is reported, not reverted", () => {
    const guard = beginGitEffectGuard(dir);
    // Simulate a second session committing while our (no-op) "command" runs —
    // the guard has no way (and must make no attempt) to tell this apart
    // from its own command's doing; either way it must never undo it.
    writeFileSync(join(dir, "a.txt"), "from another session\n");
    git(dir, ["commit", "-aq", "-m", "concurrent session commit"]);
    const concurrentSha = headSha();

    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    expect(violation?.newCommits).toContain(concurrentSha);
    // Still there — the whole point of round 4.
    expect(headSha()).toBe(concurrentSha);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("concurrent session commit");
  });

  it("`git reset --hard` to an OLDER, already-existing commit is a violation labeled MOVED (not a new commit)", () => {
    const originalHead = headSha();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, ["commit", "-aq", "-m", "second"]);
    const secondHead = headSha();
    expect(secondHead).not.toBe(originalHead);

    const guard = beginGitEffectGuard(dir);
    runShell(dir, `git reset --hard ${originalHead}`);
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    expect(violation?.newCommits).toEqual([]);
    const action = violation?.refActions.find((a) => a.ref === "refs/heads/master");
    expect(action?.kind).toBe("moved");
    expect(action?.toIsNewCommit).toBe(false);
    expect(action?.toSha).toBe(originalHead);
    expect(action?.fromSha).toBe(secondHead);
    // Never reverted back to "second" — round 4/5 only reports.
    expect(headSha()).toBe(originalHead);
  });

  it("MEDIUM FIX (b): a BACKDATED commit (old GIT_COMMITTER_DATE) is still classified as NEW, never as 'moved to existing'", () => {
    writeFileSync(join(dir, "a.txt"), "backdated-change\n");
    const guard = beginGitEffectGuard(dir);
    runShell(dir, 'git commit -am "backdated commit"', {
      GIT_COMMITTER_DATE: "2001-01-01T00:00:00",
      GIT_AUTHOR_DATE: "2001-01-01T00:00:00",
    });
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    const newSha = headSha();
    // A committer-time-based classifier would see ct far in the past and
    // wrongly bucket this as "already existing" — reachability must not care.
    expect(violation?.newCommits).toContain(newSha);
    const action = violation?.refActions.find((a) => a.ref === "refs/heads/master");
    expect(action?.toIsNewCommit).toBe(true);
  });

  it("MEDIUM FIX (d): `git branch bookmark HEAD~1` is labeled CREATED at an existing commit, not 'moved'", () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, ["commit", "-aq", "-m", "second"]);
    const parentSha = git(dir, ["rev-parse", "HEAD~1"]);

    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git branch bookmark HEAD~1");
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    expect(violation?.newCommits).toEqual([]);
    const action = violation?.refActions.find((a) => a.ref === "refs/heads/bookmark");
    expect(action?.kind).toBe("created");
    expect(action?.toIsNewCommit).toBe(false);
    expect(action?.toSha).toBe(parentSha);
    const message = violation ? effectViolationMessage(violation) : "";
    expect(message).toMatch(/created/);
    expect(message).not.toMatch(/moved/);
  });

  it("MEDIUM FIX (c): `git branch -D` (deletion) is reported, labeled DELETED", () => {
    const otherSha = refSha("other");
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git branch -D other");
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    const action = violation?.refActions.find((a) => a.ref === "refs/heads/other");
    expect(action?.kind).toBe("deleted");
    expect(action?.fromSha).toBe(otherSha);
    const message = violation ? effectViolationMessage(violation) : "";
    expect(message).toMatch(/deleted/);
  });

  it("MEDIUM FIX (c): `git tag -d` (deletion) is reported, labeled DELETED", () => {
    git(dir, ["tag", "v1.0.0"]);
    const tagSha = refSha("v1.0.0");

    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git tag -d v1.0.0");
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    const action = violation?.refActions.find((a) => a.ref === "refs/tags/v1.0.0");
    expect(action?.kind).toBe("deleted");
    expect(action?.fromSha).toBe(tagSha);
  });

  it("MEDIUM FIX: `stash pop` performs no ref mutation by the guard — the repo ends exactly where the real stash pop left it", () => {
    writeFileSync(join(dir, "a.txt"), "stashed-change\n");
    git(dir, ["stash", "push", "-q"]);
    expect(git(dir, ["stash", "list"])).not.toBe("");

    const guard = beginGitEffectGuard(dir);
    const ran = runShell(dir, "git stash pop");
    expect(ran.ok).toBe(true);
    guard?.finish(); // must not throw, and must not touch anything itself

    // The real command's own effect: working tree has the change back, stash is empty.
    expect(fsReadFileSync(join(dir, "a.txt"), "utf8")).toBe("stashed-change\n");
    expect(git(dir, ["stash", "list"])).toBe("");
    // HEAD/master were never touched by the pop itself, and the guard added nothing.
    expect(git(dir, ["status", "--porcelain"])).toContain("a.txt");
  });

  it("REFLOG-ONLY CASE: a commit then a reset back to the SAME value in one command is still detected (refs end up identical)", () => {
    const originalHead = headSha();
    const guard = beginGitEffectGuard(dir);
    runShell(dir, `git commit --allow-empty -q -m "transient" && git reset --hard ${originalHead}`);
    const violation = guard?.finish() ?? null;

    // Refs are back to exactly where they started — round 4's ref-only diff
    // would see nothing at all here.
    expect(headSha()).toBe(originalHead);
    expect(violation).not.toBeNull();
    expect(violation?.newCommits.length).toBe(1);
    // No live ref points at the transient commit anymore.
    expect(violation?.refActions).toEqual([]);
    const message = violation ? effectViolationMessage(violation) : "";
    expect(message).toMatch(/no current ref/);
  });

  it("a NEW tag pointing at a NEW commit is reported as a new commit, not a bare ref move", () => {
    const guard = beginGitEffectGuard(dir);
    runShell(dir, 'git commit --allow-empty -q -m "for-tag" && git tag v2.0.0');
    const violation = guard?.finish() ?? null;
    expect(violation).not.toBeNull();
    expect(violation?.newCommits.length).toBe(1);
    const tagAction = violation?.refActions.find((a) => a.ref === "refs/tags/v2.0.0");
    expect(tagAction?.kind).toBe("created");
    expect(tagAction?.toIsNewCommit).toBe(true);
  });

  it("a tag created at an ALREADY-EXISTING commit is created, not folded into new-commits", () => {
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git tag v1.0.0");
    const violation = guard?.finish() ?? null;
    expect(violation).not.toBeNull();
    expect(violation?.newCommits).toEqual([]);
    const action = violation?.refActions.find((a) => a.ref === "refs/tags/v1.0.0");
    expect(action?.kind).toBe("created");
    expect(action?.toIsNewCommit).toBe(false);
  });

  it("returns null for a read-only command", () => {
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git log --oneline -1");
    expect(guard?.finish() ?? null).toBeNull();
  });

  it("returns null (no guard at all) outside a git repo", () => {
    const noGitDir = mkdtempSync(join(os.tmpdir(), "git-effect-guard-nogit-"));
    try {
      expect(isInsideGitRepo(noGitDir)).toBe(false);
      expect(beginGitEffectGuard(noGitDir)).toBeNull();
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  it("effectViolationMessage never implies anything was undone", () => {
    const guard = beginGitEffectGuard(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    runShell(dir, 'git commit -am "x"');
    const violation = guard?.finish();
    expect(violation).toBeTruthy();
    const message = violation ? effectViolationMessage(violation) : "";
    expect(message).toMatch(/autoCommit is disabled for this project/);
    expect(message).toMatch(/nothing was changed/);
    expect(message).not.toMatch(/\brestored\b/);
    expect(message).not.toMatch(/reverted/i);
  });

  it("COST FIX (round 6): for-each-ref is called exactly ONCE (not twice) across a full begin+finish for a no-op command", () => {
    __resetGitCallLogForTests();
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git log --oneline -1");
    const violation = guard?.finish() ?? null;
    expect(violation).toBeNull();

    const forEachRefCalls = __getGitCallLogForTests().filter((a) => a[0] === "for-each-ref");
    expect(forEachRefCalls.length).toBe(1); // the unconditional BEFORE-side call only
  });

  it("COST FIX (round 6): for-each-ref runs a SECOND time when a ref genuinely changed (fingerprint correctly triggers it)", () => {
    __resetGitCallLogForTests();
    const guard = beginGitEffectGuard(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    runShell(dir, 'git commit -am "x"');
    const violation = guard?.finish() ?? null;
    expect(violation).not.toBeNull();

    const forEachRefCalls = __getGitCallLogForTests().filter((a) => a[0] === "for-each-ref");
    expect(forEachRefCalls.length).toBe(2); // before (unconditional) + after (fingerprint changed)
  });

  describe("KNOWN LIMITATIONS (round 6) — net-zero sequences with no ref change and no HEAD-reflog entry in the guarded worktree are OUT OF SCOPE by design", () => {
    it("H1 (per-worktree reflog): commit+reset-back in a DIFFERENT linked worktree of the same repo is invisible to a guard watching THIS worktree", () => {
      const otherWorktreeDir = join(os.tmpdir(), `git-effect-guard-wt-${Date.now()}`);
      try {
        git(dir, ["worktree", "add", "-q", "-b", "other-wt-branch", otherWorktreeDir]);
        const otherOriginalHead = git(otherWorktreeDir, ["rev-parse", "HEAD"]);

        const guard = beginGitEffectGuard(dir); // watching the ORIGINAL worktree only
        runShell(
          otherWorktreeDir,
          `git commit --allow-empty -q -m "in other worktree" && git reset --hard ${otherOriginalHead}`,
        );
        const violation = guard?.finish() ?? null;

        // Documented limitation, not a silent accident: the OTHER worktree
        // has its own HEAD and its own HEAD reflog
        // (.git/worktrees/<name>/logs/HEAD) — this guard never reads it.
        expect(violation).toBeNull();
      } finally {
        runShell(dir, `git worktree remove --force ${otherWorktreeDir}`);
      }
    });

    it("H2 (no lasting repo effect): commit-tree + a create-then-delete ghost ref in one call is invisible", () => {
      const guard = beginGitEffectGuard(dir);
      const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
      runShell(
        dir,
        `SHA=$(git commit-tree ${tree} -p HEAD -m ghost) && git update-ref refs/ghost/tmp $SHA && git update-ref -d refs/ghost/tmp`,
      );
      const violation = guard?.finish() ?? null;

      // Documented limitation: refs/ghost/tmp was created AND deleted before
      // the after-snapshot ever ran — no ref differs net, and update-ref on
      // a non-HEAD ref never touches HEAD's reflog. The commit-tree object
      // itself is left dangling (git fsck --unreachable would find it) but
      // nothing observable through refs/reflog records it ever existed.
      expect(violation).toBeNull();
    });

    it("H3 (reflog disabled): commit+reset-back with no .git/logs and core.logAllRefUpdates=false is invisible", () => {
      // Simulate "a fresh repo with reflogging off": delete every reflog
      // this fixture's own `beforeEach` already created, AND disable
      // creating new ones. Measured: deleting ONLY `.git/logs/HEAD` is not
      // enough — `git reflog show HEAD` falls back to the CURRENT branch's
      // OWN reflog (`.git/logs/refs/heads/<branch>`) when HEAD's own is
      // absent but the branch's still exists, so its count kept growing.
      // core.logAllRefUpdates=false alone does not stop writes to an
      // ALREADY-EXISTING log file either (measured) — only the removal of
      // the WHOLE `logs/` directory, combined with the config, stops every
      // reflog (HEAD's and every branch's) from being recreated at all.
      rmSync(join(dir, ".git", "logs"), { recursive: true, force: true });
      git(dir, ["config", "core.logAllRefUpdates", "false"]);
      const originalHead = headSha();

      const guard = beginGitEffectGuard(dir);
      runShell(dir, `git commit --allow-empty -q -m "reflog-off transient" && git reset --hard ${originalHead}`);
      const violation = guard?.finish() ?? null;

      // Documented limitation: this module's ENTIRE detection mechanism for
      // a "refs end up identical" sequence is the HEAD reflog — with
      // reflogging off (and no log file to even observe a count on) there
      // is no signal to read.
      expect(violation).toBeNull();
    });
  });
});
