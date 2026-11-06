/**
 * Wiring of the host-enforced git guards through the real bash / write_file
 * tools (registry.ts), in a throwaway git repo with a LOCAL bare remote — no
 * push ever leaves the temp directory.
 *
 * The test gate comes from the verify recipe's disk derivation of the repo's
 * package.json (`npm run test`), exactly what run_gate / prepareVerifyRun see.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../__test-stubs__/cleanup";
import { setCommitRunRoot } from "../orchestrator/auto-commit.js";
import { BashTool } from "./bash.js";
import { clearBashOutputCache } from "./bash-output-cache.js";
import { __resetGitSafetyState } from "./git-safety.js";
import { createBuiltinTools } from "./registry.js";

type Exec = { execute?: (input: unknown, extra?: unknown) => Promise<unknown> };

async function call(tools: Record<string, unknown>, name: string, args: Record<string, unknown>): Promise<string> {
  const t = tools[name] as Exec;
  if (!t?.execute) throw new Error(`${name} has no execute`);
  const out = await t.execute(args, { toolCallId: `${name}-${Math.random()}` });
  return typeof out === "string" ? out : JSON.stringify(out);
}

describe("native git guards through the bash tool", () => {
  let root: string;
  let repo: string;
  let remote: string;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remoteHead = () =>
    spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/main"], {
      cwd: remote,
      encoding: "utf8",
    }).stdout.trim();
  const bashes: BashTool[] = [];
  const newBash = () => {
    const b = new BashTool(repo);
    bashes.push(b);
    return b;
  };

  beforeEach(() => {
    clearBashOutputCache();
    __resetGitSafetyState();
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
    root = mkdtempSync(join(tmpdir(), "native-git-guards-"));
    repo = join(root, "repo");
    // write_file refuses targets outside the run root; this temp repo IS the run.
    setCommitRunRoot(repo);
    remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(root, "init", "-q", repo);
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "guarded", private: true, scripts: { test: "node test.js" } }, null, 2),
    );
    writeFileSync(join(repo, "test.js"), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "remote", "add", "origin", remote);
  });
  afterEach(async () => {
    setCommitRunRoot(null);
    for (const b of bashes.splice(0)) await b.cleanup();
    delete (globalThis as { __muonroiSafetyApproved?: unknown }).__muonroiSafetyApproved;
    bestEffortRemoveSync(root, "registry-native-git-guards.test.ts");
  });

  it("refuses push without a passing test-gate run, then allows it after one", async () => {
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-1" });

    const blocked = await call(tools, "bash", { command: "git push origin HEAD:refs/heads/main", timeout: 30_000 });
    expect(blocked).toMatch(/^BLOCKED \(git-safety\): refusing to run `git push`/);
    expect(blocked).toContain("test-1 `npm run test`");
    expect(remoteHead()).toBe("");

    const testRun = await call(tools, "bash", { command: "npm run test", timeout: 60_000 });
    expect(testRun).not.toMatch(/^ERROR/);

    const pushed = await call(tools, "bash", { command: "git push origin HEAD:refs/heads/main", timeout: 30_000 });
    expect(pushed).not.toMatch(/^BLOCKED/);
    expect(remoteHead()).toBe(git(repo, "rev-parse", "HEAD"));
  }, 120_000);

  it("a file write after the passing run makes the pass stale", async () => {
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-2" });
    await call(tools, "bash", { command: "npm run test", timeout: 60_000 });
    const write = await call(tools, "write_file", { file_path: "feature.js", content: "module.exports = 1;\n" });
    expect(write).toMatch(/Created feature\.js/);

    const blocked = await call(tools, "bash", { command: "git push origin HEAD:refs/heads/main", timeout: 30_000 });
    expect(blocked).toMatch(/^BLOCKED \(git-safety\)/);
    expect(blocked).toContain("predates your latest file edit");
    expect(remoteHead()).toBe("");
  }, 120_000);

  it("a failing test run blocks the push", async () => {
    writeFileSync(join(repo, "FAIL"), "");
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-3" });
    await call(tools, "bash", { command: "npm run test", timeout: 60_000 });
    const blocked = await call(tools, "bash", { command: "git push origin HEAD:refs/heads/main", timeout: 30_000 });
    expect(blocked).toContain("its last run FAILED");
  }, 120_000);

  it("refuses broad staging that would sweep a path the session did not write", async () => {
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-4" });
    await call(tools, "write_file", { file_path: "mine.js", content: "module.exports = 2;\n" });
    writeFileSync(join(repo, "user-wip.txt"), "unrelated\n");

    const blocked = await call(tools, "bash", { command: "git add -A", timeout: 30_000 });
    expect(blocked).toMatch(/^BLOCKED \(git-safety\): refusing broad staging/);
    expect(blocked).toContain("user-wip.txt");
    expect(blocked).toContain("git add -- mine.js");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");

    const explicit = await call(tools, "bash", { command: "git add -- mine.js", timeout: 30_000 });
    expect(explicit).not.toMatch(/^BLOCKED/);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("mine.js");
  }, 120_000);

  it("refuses hook bypass on commit", async () => {
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-5" });
    const out = await call(tools, "bash", { command: 'git commit --allow-empty --no-verify -m "x"', timeout: 30_000 });
    expect(out).toMatch(/^BLOCKED \(git-safety\): refusing `git commit --no-verify`/);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  }, 60_000);

  it("write_file surfaces an empty-catch warning on the tool result", async () => {
    const tools = createBuiltinTools(newBash(), "agent", { sessionId: "NGG-6" });
    const out = await call(tools, "write_file", {
      file_path: "svc.js",
      content: "try {\n  run();\n} catch (e) {}\n",
    });
    const parsed = JSON.parse(out) as { qualityWarnings?: Array<{ line: number; kind: string }>; output: string };
    expect(parsed.qualityWarnings).toEqual([expect.objectContaining({ line: 3, kind: "empty-catch" })]);
    expect(parsed.output).toContain("no-silent-catch");
  }, 60_000);
});
