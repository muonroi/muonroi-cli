import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetGitSafetyState,
  analyzeGitCommand,
  checkPushGate,
  commitBlockedMessage,
  detectSensitiveStaging,
  recordCommandOutcome,
  stagingWarning,
} from "./git-safety.js";

describe("analyzeGitCommand", () => {
  it("detects git push (with flags and chained)", () => {
    expect(analyzeGitCommand("git push").isPush).toBe(true);
    expect(analyzeGitCommand("git push origin main").isPush).toBe(true);
    expect(analyzeGitCommand("git -c x=y push --force").isPush).toBe(true);
    expect(analyzeGitCommand("git add -A && git commit -m x && git push origin main").isPush).toBe(true);
  });

  it("does not match 'push' inside a quoted commit message", () => {
    expect(analyzeGitCommand('git commit -m "fix git push regression"').isPush).toBe(false);
  });

  it("detects a real push on its own line in a multi-line script", () => {
    expect(analyzeGitCommand("git config user.name x\ngit push origin main").isPush).toBe(true);
  });

  it("does not bleed across a newline into an unrelated command", () => {
    // 'git status' then a separate line with the word 'push' is NOT a git push.
    expect(analyzeGitCommand("git status\necho push-notification").isPush).toBe(false);
    expect(analyzeGitCommand("git log\nrm push.txt").isPush).toBe(false);
  });

  it("detects broad staging (-A / . / --all / commit -a)", () => {
    expect(analyzeGitCommand("git add -A").isBroadStage).toBe(true);
    expect(analyzeGitCommand("git add .").isBroadStage).toBe(true);
    expect(analyzeGitCommand("git add --all").isBroadStage).toBe(true);
    expect(analyzeGitCommand("git commit -am 'x'").isBroadStage).toBe(true);
    expect(analyzeGitCommand("git commit -a").isBroadStage).toBe(true);
  });

  it("detects broad staging even with git global options before the subcommand", () => {
    expect(analyzeGitCommand("git -c core.editor=true commit -a").isBroadStage).toBe(true);
    expect(analyzeGitCommand("git -c x=y add -A").isBroadStage).toBe(true);
  });

  it("does not flag explicit/narrow staging or non-staging flags", () => {
    expect(analyzeGitCommand("git add src/foo.ts src/bar.ts").isBroadStage).toBe(false);
    expect(analyzeGitCommand("git add ./src/foo.ts").isBroadStage).toBe(false);
    expect(analyzeGitCommand("git commit -m 'message'").isBroadStage).toBe(false);
    expect(analyzeGitCommand("git commit --amend").isBroadStage).toBe(false);
    // -a must be a clean flag cluster — a malformed `-a--otherflag` is not `-a`.
    expect(analyzeGitCommand("git commit -a--otherflag").isBroadStage).toBe(false);
  });

  it("detects any `git commit` for the LSP commit gate (with or without -a)", () => {
    expect(analyzeGitCommand("git commit -m 'x'").isCommit).toBe(true);
    expect(analyzeGitCommand("git commit").isCommit).toBe(true);
    expect(analyzeGitCommand("git commit -am 'x'").isCommit).toBe(true);
    expect(analyzeGitCommand("git commit --amend --no-edit").isCommit).toBe(true);
    expect(analyzeGitCommand("git -c x=y commit -m 'x'").isCommit).toBe(true);
    expect(analyzeGitCommand("git add -A && git commit -m 'x'").isCommit).toBe(true);
  });

  it("does not treat commit plumbing / quoted messages as a commit", () => {
    // `commit` must terminate at whitespace/clause-end — plumbing subcommands stay clear.
    expect(analyzeGitCommand("git commit-tree $TREE").isCommit).toBe(false);
    expect(analyzeGitCommand("git commit-graph write").isCommit).toBe(false);
    // option values and quoted messages mentioning commit must not match.
    expect(analyzeGitCommand("git log --grep=commit").isCommit).toBe(false);
    expect(analyzeGitCommand('git push -m "amend the commit later"').isCommit).toBe(false);
    // separate clause / line cannot bleed in.
    expect(analyzeGitCommand("git status\necho commit").isCommit).toBe(false);
  });

  it("separates broad-add from commit-all so the gate scopes the right path set", () => {
    const addAll = analyzeGitCommand("git add -A");
    expect(addAll.isBroadAdd).toBe(true);
    expect(addAll.isCommitAll).toBe(false);

    const commitAll = analyzeGitCommand("git commit -am 'x'");
    expect(commitAll.isCommitAll).toBe(true);
    expect(commitAll.isBroadAdd).toBe(false);
    expect(commitAll.isCommit).toBe(true);

    const plainCommit = analyzeGitCommand("git commit -m 'x'");
    expect(plainCommit.isBroadAdd).toBe(false);
    expect(plainCommit.isCommitAll).toBe(false);
    expect(plainCommit.isCommit).toBe(true);
  });
});

describe("commitBlockedMessage", () => {
  it("surfaces the diagnostic summary and does NOT advertise the env bypass", () => {
    const msg = commitBlockedMessage("src/foo.ts:3 error TS2322");
    expect(msg).toMatch(/BLOCKED/);
    expect(msg).toContain("src/foo.ts:3 error TS2322");
    expect(msg).toMatch(/git_commit/);
    // G1 convention: the user-only escape hatch is never shown to the agent.
    expect(msg).not.toMatch(/MUONROI_COMMIT_GATE/);
  });

  it("falls back gracefully when no summary is provided", () => {
    expect(commitBlockedMessage()).toMatch(/no diagnostic detail/i);
  });
});

describe("push gate", () => {
  beforeEach(() => {
    __resetGitSafetyState();
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
  });
  afterEach(() => {
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
  });

  it("does not block when no verification has failed", () => {
    expect(checkPushGate("s1").blocked).toBe(false);
  });

  it("blocks push after a verification command fails", () => {
    recordCommandOutcome("s1", "npm test", false);
    const gate = checkPushGate("s1");
    expect(gate.blocked).toBe(true);
    expect(gate.failed).toContain("npm test");
  });

  it("clears the block when that same command re-runs green", () => {
    recordCommandOutcome("s1", "npm test", false);
    expect(checkPushGate("s1").blocked).toBe(true);
    recordCommandOutcome("s1", "npm test", true);
    expect(checkPushGate("s1").blocked).toBe(false);
  });

  it("a different verify passing does NOT clear an unrelated failed verify", () => {
    recordCommandOutcome("s1", "npm test", false);
    recordCommandOutcome("s1", "npm run build", true); // build green, tests still red
    expect(checkPushGate("s1").blocked).toBe(true);
    expect(checkPushGate("s1").failed).toEqual(["npm test"]);
  });

  it("is session-scoped (one session's failure does not gate another)", () => {
    recordCommandOutcome("s1", "vitest run", false);
    expect(checkPushGate("s1").blocked).toBe(true);
    expect(checkPushGate("s2").blocked).toBe(false);
  });

  it("ignores non-verification command outcomes", () => {
    recordCommandOutcome("s1", "git status", false);
    recordCommandOutcome("s1", "ls -la", false);
    expect(checkPushGate("s1").blocked).toBe(false);
  });

  it("respects the MUONROI_ALLOW_PUSH_ON_RED override", () => {
    recordCommandOutcome("s1", "npm test", false);
    process.env.MUONROI_ALLOW_PUSH_ON_RED = "1";
    expect(checkPushGate("s1").blocked).toBe(false);
  });
});

describe("sensitive staging detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-safety-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags .env and .muonroi-cli present in the repo root", () => {
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, ".muonroi-cli"), ""); // a file is enough for existsSync
    const found = detectSensitiveStaging(dir);
    expect(found).toContain(".env");
    expect(found).toContain(".muonroi-cli");
    expect(stagingWarning(dir)).toMatch(/WARNING/);
  });

  it("returns no warning for a clean repo", () => {
    writeFileSync(join(dir, "README.md"), "# ok");
    expect(detectSensitiveStaging(dir)).toEqual([]);
    expect(stagingWarning(dir)).toBe("");
  });
});
