/**
 * Unit coverage for the host-enforced git guards that replaced prompt prose:
 *   M1 push gate (test-gate pass after the last native write),
 *   M2 hook bypass refusal,
 *   M3 broad staging of paths the session did not write.
 * Wiring through the bash tool is covered by registry-native-git-guards.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../__test-stubs__/cleanup";
import {
  __resetGitSafetyState,
  analyzeGitCommand,
  checkForeignStaging,
  checkHookBypass,
  checkPushGate,
  nextGitSafetySeq,
  noteFileWrites,
  type PushGateContext,
  parseRunClauses,
  pushBlockedMessage,
  recordBashRun,
  recordGateRun,
  recordVerificationRun,
} from "./git-safety.js";

const run = (key: string, cwd: string, command: string, success: boolean) =>
  recordBashRun(key, cwd, command, success, nextGitSafetySeq());

describe("parseRunClauses", () => {
  it("follows cd clauses and strips redirections", () => {
    const base = join(tmpdir(), "proj");
    const parsed = parseRunClauses("cd sub && bun run test 2>&1 > out.log", base);
    expect(parsed.masked).toBe(false);
    expect(parsed.clauses).toEqual([{ dir: join(base, "sub"), command: "bun run test" }]);
  });

  it("marks pipes, ;, || and background & as masked", () => {
    for (const cmd of ["bun run test | tail -5", "bun run test; echo ok", "bun run test || true", "bun run test &"])
      expect(parseRunClauses(cmd, tmpdir()).masked, cmd).toBe(true);
  });

  it("does not treat operators inside quotes as control operators", () => {
    const parsed = parseRunClauses(`node -e "process.exit(a => b | c)"`, tmpdir());
    expect(parsed.masked).toBe(false);
    expect(parsed.clauses[0]!.command).toBe(`node -e "process.exit(a => b | c)"`);
  });
});

describe("push gate with a test-gate catalog (M1)", () => {
  const cwd = join(tmpdir(), "push-gate-proj");
  const ctx: PushGateContext = { cwd, requiredGates: [{ id: "test-1", command: "npm run test" }], gateSource: "test" };

  beforeEach(() => {
    __resetGitSafetyState();
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
  });
  afterEach(() => delete process.env.MUONROI_ALLOW_PUSH_ON_RED);

  it("blocks when the gate never ran, and the message names the command to run", () => {
    const gate = checkPushGate("k", ctx);
    expect(gate.blocked).toBe(true);
    expect(gate.missing).toEqual([{ id: "test-1", command: "npm run test", reason: "never-run" }]);
    const msg = pushBlockedMessage(gate);
    expect(msg).toContain("`npm run test`");
    expect(msg).toContain("no run recorded");
  });

  it("allows after an unpiped passing run", () => {
    run("k", cwd, "npm run test", true);
    expect(checkPushGate("k", ctx).blocked).toBe(false);
  });

  it("accepts a cd-prefixed run from the parent directory", () => {
    run("k", join(cwd, ".."), "cd push-gate-proj && npm run test", true);
    expect(checkPushGate("k", ctx).blocked).toBe(false);
  });

  it("a write AFTER the pass makes it stale", () => {
    run("k", cwd, "npm run test", true);
    noteFileWrites("k", [join(cwd, "src", "a.ts")]);
    const gate = checkPushGate("k", ctx);
    expect(gate.blocked).toBe(true);
    expect(gate.missing[0]!.reason).toBe("stale");
    run("k", cwd, "npm run test", true);
    expect(checkPushGate("k", ctx).blocked).toBe(false);
  });

  it("a piped pass does not count (its exit code is the pipe's)", () => {
    run("k", cwd, "npm run test | tail -20", true);
    const gate = checkPushGate("k", ctx);
    expect(gate.blocked).toBe(true);
    expect(gate.missing[0]!.reason).toBe("masked");
  });

  it("a later failure overrides an earlier pass", () => {
    run("k", cwd, "npm run test", true);
    run("k", cwd, "npm run test", false);
    expect(checkPushGate("k", ctx).missing[0]!.reason).toBe("failed");
  });

  it("a pass in another directory does not satisfy this repo's gate", () => {
    run("k", join(tmpdir(), "other-proj"), "npm run test", true);
    expect(checkPushGate("k", ctx).blocked).toBe(true);
  });

  it("run_gate passes count", () => {
    recordGateRun("k", cwd, "npm run test", true, nextGitSafetySeq());
    expect(checkPushGate("k", ctx).blocked).toBe(false);
  });

  it("verification_run failures block; its passes alone never satisfy the gate", () => {
    run("k", cwd, "npm run test", true);
    recordVerificationRun("k", ["a.test.ts"], false);
    const gate = checkPushGate("k", ctx);
    expect(gate.blocked).toBe(true);
    expect(gate.failed).toEqual(["verification_run a.test.ts"]);
    recordVerificationRun("k", ["a.test.ts"], true);
    expect(checkPushGate("k", ctx).blocked).toBe(false);

    __resetGitSafetyState();
    recordVerificationRun("k", ["a.test.ts"], true);
    expect(checkPushGate("k", ctx).blocked).toBe(true);
  });

  it("matches the package.json script body for a script gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-script-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bunx vitest run" } }));
      run("k", dir, "bunx vitest run", true);
      expect(
        checkPushGate("k", { cwd: dir, requiredGates: [{ id: "test-1", command: "bun run test" }], gateSource: "t" })
          .blocked,
      ).toBe(false);
    } finally {
      bestEffortRemoveSync(dir, "git-safety-native-guards.test.ts");
    }
  });

  it("no detectable test gate → allowed with a warning", () => {
    const gate = checkPushGate("k", { cwd, requiredGates: [], gateSource: "disk derivation" });
    expect(gate.blocked).toBe(false);
    expect(gate.warning).toMatch(/no test gate detected/);
  });

  it("MUONROI_ALLOW_PUSH_ON_RED=1 overrides", () => {
    process.env.MUONROI_ALLOW_PUSH_ON_RED = "1";
    expect(checkPushGate("k", ctx).blocked).toBe(false);
  });
});

describe("hook bypass (M2)", () => {
  afterEach(() => delete process.env.MUONROI_ALLOW_HOOK_BYPASS);

  it.each([
    "git commit --no-verify -m wip",
    'git commit -m "x" --no-verify',
    "git commit -nm wip",
    "git commit -an -m wip",
    "git commit --no-veri -m x",
    "git push --no-verify origin main",
    "git -c core.hooksPath=/dev/null commit -m x",
    "HUSKY=0 git commit -m x",
    "export HUSKY=0 && git push",
    "git config core.hooksPath /tmp/none",
    "git config --unset core.hooksPath",
  ])("refuses %s", (cmd) => {
    const shape = analyzeGitCommand(cmd);
    expect(shape.hookBypass, cmd).not.toBeNull();
    expect(checkHookBypass(shape).blocked).toBe(true);
  });

  it.each([
    "git push -n origin main", // -n is --dry-run for push
    'git commit -m "skip with --no-verify next time"', // quoted message
    "git commit -m n", // -m takes the value "n"
    "git commit -am fix",
    "git config core.hooksPath", // read
    "git config --get core.hooksPath",
    "git log --no-verify-signatures", // not a commit/push
    "git status",
  ])("allows %s", (cmd) => {
    expect(analyzeGitCommand(cmd).hookBypass, cmd).toBeNull();
  });

  it("user escape hatch MUONROI_ALLOW_HOOK_BYPASS=1", () => {
    process.env.MUONROI_ALLOW_HOOK_BYPASS = "1";
    expect(checkHookBypass(analyzeGitCommand("git commit --no-verify -m x")).blocked).toBe(false);
  });
});

describe("broad staging of foreign paths (M3)", () => {
  let repo: string;
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  beforeEach(() => {
    __resetGitSafetyState();
    delete process.env.MUONROI_ALLOW_BROAD_STAGE;
    repo = mkdtempSync(join(tmpdir(), "gs-foreign-"));
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "init");
  });
  afterEach(() => {
    delete process.env.MUONROI_ALLOW_BROAD_STAGE;
    bestEffortRemoveSync(repo, "git-safety-native-guards.test.ts");
  });

  it("refuses `git add -A` while a path the session did not write is dirty, naming it", () => {
    writeFileSync(join(repo, "mine.ts"), "x\n");
    noteFileWrites("k", [join(repo, "mine.ts")]);
    writeFileSync(join(repo, "user-wip.txt"), "wip\n");
    const r = checkForeignStaging("k", repo, analyzeGitCommand("git add -A"));
    expect(r.blocked).toBe(true);
    expect(r.foreign).toEqual(["user-wip.txt"]);
    expect(r.message).toContain("user-wip.txt");
    expect(r.message).toContain("git add -- mine.ts");
  });

  it("allows `git add -A` when every dirty path was written by the session", () => {
    writeFileSync(join(repo, "mine.ts"), "x\n");
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    noteFileWrites("k", [join(repo, "mine.ts"), join(repo, "tracked.txt")]);
    expect(checkForeignStaging("k", repo, analyzeGitCommand("git add -A")).blocked).toBe(false);
  });

  it("`commit -a` / `add -u` only consider tracked modifications", () => {
    writeFileSync(join(repo, "untracked-user.txt"), "u\n");
    expect(checkForeignStaging("k", repo, analyzeGitCommand("git commit -am x")).blocked).toBe(false);
    writeFileSync(join(repo, "tracked.txt"), "user edit\n");
    const r = checkForeignStaging("k", repo, analyzeGitCommand("git add -u"));
    expect(r.blocked).toBe(true);
    expect(r.foreign).toEqual(["tracked.txt"]);
  });

  it("`git add .` only considers paths under the cwd", () => {
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "pkg", "mine.ts"), "x\n");
    noteFileWrites("k", [join(repo, "pkg", "mine.ts")]);
    writeFileSync(join(repo, "outside.txt"), "o\n");
    expect(checkForeignStaging("k", join(repo, "pkg"), analyzeGitCommand("git add .")).blocked).toBe(false);
    expect(checkForeignStaging("k", repo, analyzeGitCommand("git add .")).blocked).toBe(true);
  });

  it("explicit staging is never checked; MUONROI_ALLOW_BROAD_STAGE=1 overrides", () => {
    writeFileSync(join(repo, "user-wip.txt"), "wip\n");
    expect(checkForeignStaging("k", repo, analyzeGitCommand("git add mine.ts")).blocked).toBe(false);
    process.env.MUONROI_ALLOW_BROAD_STAGE = "1";
    expect(checkForeignStaging("k", repo, analyzeGitCommand("git add -A")).blocked).toBe(false);
  });

  it("outside a git repository it does not block", () => {
    const plain = mkdtempSync(join(tmpdir(), "gs-plain-"));
    try {
      writeFileSync(join(plain, "a.txt"), "a");
      expect(checkForeignStaging("k", plain, analyzeGitCommand("git add -A")).blocked).toBe(false);
    } finally {
      bestEffortRemoveSync(plain, "git-safety-native-guards.test.ts");
    }
  });
});
