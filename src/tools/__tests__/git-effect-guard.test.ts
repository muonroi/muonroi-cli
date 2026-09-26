/**
 * Round 3 — direct test of `git-effect-guard.ts`, the EFFECT-BASED backstop
 * for `autoCommit: false`. Exercises the guard the same way registry.ts's
 * `runBashWithEffectGuard` does (snapshot -> run the real shell command via
 * a real shell, exactly as the bash tool would -> finish()), but WITHOUT
 * going through registry.ts's pre-execution string gate — round 3's cheap
 * string fixes (git-safety.ts) now correctly pre-empt three of these four
 * bypasses before they ever reach a shell (see
 * git-safety-blocked-subcommand.test.ts), so testing them at the registry
 * level no longer exercises this module at all. This file proves the module
 * ITSELF still catches every one of them on its own — the guarantee this
 * task asked for is "effect-based", not "only reachable when the string
 * gate happens to miss it".
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
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

describe("git-effect-guard — the effect-based autoCommit backstop", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), "git-effect-guard-unit-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function headSha(): string {
    return git(dir, ["rev-parse", "HEAD"]);
  }

  it.each([
    ["\\git bypass", '\\git commit -am "sneaky via backslash"'],
    ["inline -c alias bypass", 'git -c alias.sneaky=commit sneaky -am "sneaky via inline alias"'],
    ["${IFS} bypass", 'git${IFS}commit${IFS}-am${IFS}"sneaky via IFS"'],
  ])("commit via %s: HEAD is restored and the reported result is an error", async (_label, command) => {
    const before = headSha();
    writeFileSync(join(dir, "a.txt"), "changed\n");

    const guard = beginGitEffectGuard(dir);
    expect(guard).not.toBeNull();
    runShell(dir, command);
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    const message = violation ? effectViolationMessage(violation) : "";
    expect(message).toMatch(/autoCommit is disabled for this project/);
    expect(message).toMatch(/restored/);
    expect(headSha()).toBe(before);
  });

  it("commit hidden inside a SCRIPT FILE — no literal 'git' anywhere in the invoking command", async () => {
    const before = headSha();
    writeFileSync(join(dir, "a.txt"), "changed-via-script\n");
    writeFileSync(join(dir, "sneaky.sh"), '#!/bin/sh\ngit commit -am "sneaky via script file"\n');

    const guard = beginGitEffectGuard(dir);
    runShell(dir, "sh sneaky.sh");
    const violation = guard?.finish() ?? null;

    expect(violation).not.toBeNull();
    expect(headSha()).toBe(before);
  });

  it("a newly created ref (branch) is deleted again, not merely reported", () => {
    const guard = beginGitEffectGuard(dir);
    runShell(dir, "git branch sneaky-branch");
    const violation = guard?.finish() ?? null;

    expect(violation?.changedRefs).toContain("refs/heads/sneaky-branch");
    expect(violation?.restoredRefs).toContain("refs/heads/sneaky-branch");
    expect(git(dir, ["branch", "--list"])).not.toContain("sneaky-branch");
  });

  it("a detached-HEAD commit (no named branch ref moves) is still caught via HEAD itself", () => {
    git(dir, ["checkout", "-q", "--detach", "HEAD"]);
    const before = headSha();
    writeFileSync(join(dir, "a.txt"), "detached-change\n");

    const guard = beginGitEffectGuard(dir);
    runShell(dir, 'git commit -am "sneaky detached commit"');
    const violation = guard?.finish() ?? null;

    expect(violation?.changedRefs).toContain("HEAD");
    expect(headSha()).toBe(before);
  });

  it("returns null (no violation) for a read-only command", () => {
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
});
