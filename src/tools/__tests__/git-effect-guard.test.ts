/**
 * Round 4 — round 3's auto-restore was ITSELF destructive: a refuter found
 * it rewrote a branch's tip via a benign `git checkout other` (update-ref
 * HEAD through the symbolic ref moved `other`, not just the local HEAD
 * pointer), reverted another session's concurrent legitimate commit, and
 * left a `stash pop` half-restored. A dead `reflogGrew`/`stashChanged` path
 * was also mutant-survivable.
 *
 * New contract: DETECT AND REPORT, NEVER MUTATE. This file tests
 * `git-effect-guard.ts` directly — no `update-ref`/`reset`/`stash` call
 * exists anywhere in the module now (grepped below as a structural guard
 * against regressing back to round 3's design), and every case here asserts
 * the repository's ACTUAL state is exactly what the raw command itself
 * produced, never anything extra.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync as fsReadFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginGitEffectGuard, effectViolationMessage, isInsideGitRepo } from "../git-effect-guard.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run `command` through a real shell in `cwd`, the same way BashTool does — never throws. */
function runShell(cwd: string, command: string): { ok: boolean } {
  try {
    execSync(command, { cwd, stdio: "pipe" });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe("git-effect-guard — detect and report, never mutate (round 4)", () => {
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
    expect(violation?.refsWithNewCommits).toContain("refs/heads/master");
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

  it("`git reset --hard` to an OLDER, already-existing commit is a violation (moved-to-existing, not a new commit)", () => {
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
    expect(violation?.movedToExistingRefs).toContain("refs/heads/master");
    // Never reverted back to "second" — round 4 only reports.
    expect(headSha()).toBe(originalHead);
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

  it("a NEW tag is a violation", () => {
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git tag v1.0.0");
    const violation = guard?.finish() ?? null;
    expect(violation).not.toBeNull();
    expect(violation?.movedToExistingRefs).toContain("refs/tags/v1.0.0");
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
    expect(message).not.toMatch(/restored/);
    expect(message).not.toMatch(/reverted/i);
  });
});
