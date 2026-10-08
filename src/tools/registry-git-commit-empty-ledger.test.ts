/**
 * Slice G — `git_commit`'s empty-write-ledger refusal must not read as a claim
 * about the repository.
 *
 * Measured (run muc2joffe506 / session 2a116648b48e): the refusal string was
 * returned at 06:13:58 and again at 06:53:00 while THREE commits landed in the
 * same repo over the same span (4d73157, 1ca6267, a301b06), all made through
 * `bash git commit`. The sentence was true about the tool's own write ledger and
 * read as false about the repo — and it named no route, so the agent stopped
 * trying: 1 edit_file followed by 163 bash calls.
 *
 * The BEHAVIOUR is deliberately unchanged (staging only tool-written paths is
 * what keeps .env / .muonroi-cli out of the index). Only the message changes, so
 * these tests pin its SHAPE — ledger scope named, repository state reported, the
 * working route named — never its prose, plus the unchanged commit path.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCommitRunRoot } from "../orchestrator/auto-commit.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown, extra?: { toolCallId?: string }) => Promise<unknown> | unknown;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.hooksPath", ""]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "--", "seed.txt"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
}

/** Call the real git_commit tool and return its output + success. */
async function runGitCommit(
  cwd: string,
  sessionId: string,
  message: string,
): Promise<{ success: boolean; output: string; tools: Record<string, unknown> }> {
  const tools = createBuiltinTools(new BashTool(cwd), "agent", { sessionId }) as Record<string, unknown>;
  const t = tools.git_commit as ToolWithExecute;
  if (!t?.execute) throw new Error("git_commit tool has no execute");
  const res = (await t.execute({ message })) as { success: boolean; output: string };
  return { success: res.success, output: res.output, tools };
}

/** The refusal must name the ledger the tool actually reads, by tool name. */
function namesLedgerScope(output: string): boolean {
  return output.includes("write_file") && output.includes("edit_file") && output.includes("git_commit");
}

/** The refusal must name the route that does work — `git commit` via bash. */
function namesBashRoute(output: string): boolean {
  return output.includes("bash") && output.includes("git commit");
}

describe("git_commit refusal with an empty write ledger", () => {
  const dirs: string[] = [];
  let savedRunRoot: string | null = null;

  beforeEach(() => {
    savedRunRoot = null;
  });

  afterEach(() => {
    setCommitRunRoot(savedRunRoot);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function tempDir(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
  }

  it("reports a CLEAN repo as clean, names the ledger scope, and names the bash route", async () => {
    const repo = tempDir("muonroi-ledger-clean-");
    initRepo(repo);

    const { success, output } = await runGitCommit(repo, "GC-CLEAN", "feat(x): something");

    expect(success).toBe(false);
    expect(namesLedgerScope(output)).toBe(true);
    expect(namesBashRoute(output)).toBe(true);
    // A clean repo is stated as such — no count is invented.
    expect(output.toLowerCase()).toContain("no uncommitted");
  }, 30_000);

  it("reports the REAL number of uncommitted changes in a dirty repo (2, then 5)", async () => {
    const repo = tempDir("muonroi-ledger-dirty-");
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");

    const two = await runGitCommit(repo, "GC-DIRTY-2", "feat(x): something");
    expect(two.success).toBe(false);
    expect(namesLedgerScope(two.output)).toBe(true);
    expect(namesBashRoute(two.output)).toBe(true);
    // The count is the repo's real change count, not a fixed phrase: it tracks
    // the working tree. 2 changed paths -> the message carries 2.
    expect(two.output).toContain("2");
    expect(two.output.toLowerCase()).not.toContain("no uncommitted");

    writeFileSync(join(repo, "c.txt"), "c\n");
    writeFileSync(join(repo, "d.txt"), "d\n");
    writeFileSync(join(repo, "e.txt"), "e\n");

    const five = await runGitCommit(repo, "GC-DIRTY-5", "feat(x): something");
    expect(five.success).toBe(false);
    expect(five.output).toContain("5");
    expect(five.output).not.toContain("2");
  }, 30_000);

  it("degrades without a count (and without throwing) when the git query fails", async () => {
    // A plain temp dir is not a git repo, so `git status --porcelain` exits
    // non-zero — the same degrade path as any git failure.
    const notARepo = tempDir("muonroi-ledger-nogit-");

    const { success, output } = await runGitCommit(notARepo, "GC-NOGIT", "feat(x): something");

    expect(success).toBe(false);
    // Still useful: scope + route survive a failed git query.
    expect(namesLedgerScope(output)).toBe(true);
    expect(namesBashRoute(output)).toBe(true);
    // No fabricated state either way.
    expect(output.toLowerCase()).not.toContain("no uncommitted");
    expect(output.toLowerCase()).not.toContain("uncommitted change(s)");
  }, 30_000);

  it("BEHAVIOUR UNCHANGED: with a tool-written path, the commit path still runs", async () => {
    const repo = tempDir("muonroi-ledger-written-");
    initRepo(repo);
    savedRunRoot = null;
    // The commit path's containment gate compares the cwd's worktree root to the
    // run root; pin the run root at the fixture so the commit is in scope.
    setCommitRunRoot(repo);

    const tools = createBuiltinTools(new BashTool(repo), "agent", { sessionId: "GC-WRITTEN" }) as Record<
      string,
      unknown
    >;
    const write = tools.write_file as ToolWithExecute;
    if (!write?.execute) throw new Error("write_file tool has no execute");
    await write.execute({ file_path: "new.txt", content: "hello\n" });

    const commit = tools.git_commit as ToolWithExecute;
    if (!commit?.execute) throw new Error("git_commit tool has no execute");
    const res = (await commit.execute({ message: "feat(x): add new.txt" })) as {
      success: boolean;
      output: string;
    };

    expect(res.success).toBe(true);
    expect(res.output).toContain("Committed");
    // The refusal shape must NOT appear once the ledger is non-empty.
    expect(namesBashRoute(res.output)).toBe(false);
    expect(git(repo, ["show", "--name-only", "--format=%s", "HEAD"])).toContain("new.txt");
  }, 60_000);
});
