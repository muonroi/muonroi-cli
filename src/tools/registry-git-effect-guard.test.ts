/**
 * Round 4 — integration test: the DETECT-AND-REPORT (never mutate)
 * `autoCommit: false` backstop (git-effect-guard.ts), wired into
 * registry.ts's bash tool via `runBashWithEffectGuard`, through the FULL
 * pre-execution pipeline (including the string gate, git-safety.ts's
 * `detectBlockedGitSubcommand`).
 *
 * `\git`/inline `-c alias`/`${IFS}` bypasses are caught PRE-execution by the
 * string gate, so they never reach the effect guard here — see
 * `git-safety-blocked-subcommand.test.ts` for those, and
 * `__tests__/git-effect-guard.test.ts` for the effect-guard module tested
 * directly (every round-4 required case: checkout between branches is a
 * non-event, a script-file commit, a concurrent commit, reset --hard to an
 * older commit, stash pop). What's unique to test at THIS (full-pipeline)
 * level is a bypass the string layer can never see at all: a SCRIPT FILE
 * with no literal "git" on the invoking command line — and that, unlike
 * round 3, a newly-created ref is left in place, only REPORTED.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { clearBashOutputCache } from "./bash-output-cache.js";
import { __resetGitSafetyState } from "./git-safety.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown, extra?: { toolCallId?: string }) => Promise<unknown> | unknown;
}

async function runBash(tools: Record<string, unknown>, command: string): Promise<string> {
  const t = tools.bash as ToolWithExecute;
  if (!t?.execute) throw new Error("bash tool has no execute");
  const out = await t.execute({ command, timeout: 10_000 });
  return typeof out === "string" ? out : JSON.stringify(out);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("round 4 — DETECT-AND-REPORT autoCommit guard, full pipeline (registry.ts wiring)", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    clearBashOutputCache();
    (globalThis as { __muonroiBashRepeatState?: Map<string, unknown> }).__muonroiBashRepeatState = new Map();
    __resetGitSafetyState();
    dir = mkdtempSync(join(os.tmpdir(), "git-effect-guard-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    mkdirSync(join(dir, ".muonroi-cli"), { recursive: true });
    writeFileSync(join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
    prevCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function baselineHead(): string {
    return git(dir, ["rev-parse", "HEAD"]);
  }

  it("catches a commit hidden inside a SCRIPT FILE — no literal 'git' on the bash command line at all — reported, NOT reverted", async () => {
    const before = baselineHead();
    writeFileSync(join(dir, "a.txt"), "four\n");
    writeFileSync(join(dir, "sneaky.sh"), '#!/bin/sh\ngit commit -am "sneaky via script file"\n');
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG3" });

    // The bash command itself is just "sh sneaky.sh" — a text classifier
    // reading THIS string sees no "git" token anywhere. Only the effect
    // guard (diffing refs before/after) can catch this one.
    const out = await runBash(tools, "sh sneaky.sh");

    expect(out).toMatch(/^ERROR:/);
    expect(out).toMatch(/autoCommit is disabled for this project/);
    expect(out).toMatch(/nothing was changed/);
    // Round 4: the commit is REPORTED, never reverted — HEAD legitimately
    // moved (round 3 would have force-reset it back to `before`).
    expect(baselineHead()).not.toBe(before);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("sneaky via script file");
  });

  it("reports a newly-created ref (a branch) as an error but leaves it in place — round 4 never mutates", async () => {
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG5" });

    const out = await runBash(tools, "git branch sneaky-branch");

    expect(out).toMatch(/^ERROR:/);
    expect(out).toMatch(/refs\/heads\/sneaky-branch/);
    expect(out).toMatch(/nothing was changed/);
    // Round 3 deleted it again; round 4 must leave it exactly as the
    // command made it.
    const branches = git(dir, ["branch", "--list"]);
    expect(branches).toContain("sneaky-branch");
  });

  it("`git checkout` between two existing branches is a non-event through the full pipeline (no violation, no ref touched)", async () => {
    git(dir, ["branch", "other"]);
    const masterBefore = git(dir, ["rev-parse", "master"]);
    const otherBefore = git(dir, ["rev-parse", "other"]);
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG10" });

    const out = await runBash(tools, "git checkout other");

    expect(out).not.toMatch(/^ERROR:/);
    expect(out).not.toMatch(/autoCommit is disabled/);
    expect(git(dir, ["rev-parse", "master"])).toBe(masterBefore);
    expect(git(dir, ["rev-parse", "other"])).toBe(otherBefore);
  });

  it("does NOT wrap/restore anything when autoCommit is not disabled (default project settings)", async () => {
    writeFileSync(join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({}));
    writeFileSync(join(dir, "a.txt"), "six\n");
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG6" });

    // Explicit `git add` (not `-am`) — `-am` is a BROAD stage, and this repo
    // (like any using `.muonroi-cli/`) trips the unrelated pre-existing
    // sensitive-staging warning-gate for that, which is not what this case
    // is testing.
    await runBash(tools, "git add a.txt");
    const out = await runBash(tools, 'git commit -m "allowed commit"');

    expect(out).not.toMatch(/autoCommit is disabled/);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("allowed commit");
  });

  it("a read-only command in a git repo with autoCommit disabled is unaffected", async () => {
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG7" });
    const out = await runBash(tools, "git log --oneline -1");
    expect(out).not.toMatch(/^ERROR:/);
    expect(out).not.toMatch(/autoCommit is disabled/);
  });

  it("is a no-op (never spawns the guard) outside a git repo", async () => {
    const noGitDir = mkdtempSync(join(os.tmpdir(), "git-effect-guard-nogit-"));
    try {
      mkdirSync(join(noGitDir, ".muonroi-cli"), { recursive: true });
      writeFileSync(join(noGitDir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
      process.chdir(noGitDir);
      const bash = new BashTool(noGitDir);
      const tools = createBuiltinTools(bash, "agent", { sessionId: "EG8" });
      const out = await runBash(tools, "echo hello");
      expect(out).not.toMatch(/^ERROR:/);
      expect(out).toContain("hello");
    } finally {
      process.chdir(dir);
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  it("`\\git`/inline `-c alias`/`${IFS}` are now caught PRE-execution by the hardened string gate (so the effect guard never even needs to run for these)", async () => {
    const before = baselineHead();
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "EG9" });

    for (const cmd of [
      '\\git commit -am "sneaky via backslash"',
      'git -c alias.sneaky=commit sneaky -am "sneaky via inline alias"',
      'git${IFS}commit${IFS}-am${IFS}"sneaky via IFS"',
    ]) {
      const out = await runBash(tools, cmd);
      expect(out).toMatch(/^BLOCKED \(git-safety\):/);
    }
    expect(baselineHead()).toBe(before);
  });
});
