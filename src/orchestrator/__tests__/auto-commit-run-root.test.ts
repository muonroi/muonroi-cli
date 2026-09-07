/**
 * Run-root containment for git history (incident 2026-09-06).
 *
 * Reproduces the exact shape of the escape: a run launched inside a LINKED
 * WORKTREE, whose tool cwd then drifts to the worktree's PARENT repo (the bash
 * tool's `cd` handler mutates BashTool.cwd with no containment —
 * src/tools/bash.ts:170), after which both commit entry points
 * (orchestrator.ts:3590 and src/tools/registry.ts:836 — both read
 * `bash.getCwd()`) write history onto the parent repo's branch.
 *
 * The fixture below is that geometry verbatim: `parent/` is a repo, `child/` is
 * a linked worktree INSIDE it on its own branch, the run root is pinned to
 * `child/`, and the commit is attempted with cwd = `parent/`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCommitScope,
  commitSpecificPaths,
  getCommitRunRoot,
  maybeAutoCommitTurn,
  setCommitRunRoot,
} from "../auto-commit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.hooksPath", ""]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
}

describe("auto-commit run-root containment", () => {
  let root: string;
  let parent: string;
  let child: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "muonroi-runroot-")));
    parent = join(root, "parent");
    mkdirSync(parent);
    initRepo(parent);
    // A LINKED WORKTREE placed INSIDE the parent repo — the `.sprint-a7`
    // geometry. Its `.git` is a FILE, and `rev-parse --show-toplevel` reports
    // the worktree dir, not the parent.
    child = join(parent, "child");
    git(parent, ["worktree", "add", "-q", "-b", "sprint/x", child]);
    // The LSP quality gate is orthogonal to containment and would add seconds
    // of cold-tsserver wait to every commit here.
    process.env.MUONROI_COMMIT_GATE = "0";
  });

  afterEach(() => {
    setCommitRunRoot(null);
    process.env = { ...savedEnv };
    try {
      git(parent, ["worktree", "remove", "--force", child]);
    } catch (err) {
      // Best-effort: the temp tree is deleted right below anyway. Logged so a
      // Windows file-lock failure is never invisible.
      console.error(`[auto-commit-run-root.test] worktree remove failed: ${(err as Error)?.message}`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("git and the fixture agree that the worktree is a DIFFERENT toplevel from its parent", () => {
    expect(resolve(git(child, ["rev-parse", "--show-toplevel"]).trim())).toBe(child);
    expect(resolve(git(parent, ["rev-parse", "--show-toplevel"]).trim())).toBe(parent);
  });

  // ---- the reproduction -------------------------------------------------

  it("REFUSES an agent-authored commit whose cwd drifted out of the run's worktree (git_commit path)", async () => {
    setCommitRunRoot(child);
    const before = headSha(parent);
    writeFileSync(join(parent, "leaked.ts"), "export const x = 1;\n");

    const res = await commitSpecificPaths(parent, ["leaked.ts"], "feat: should never land");

    expect(res.committed).toBe(false);
    expect(res.reason).toBe("outside-run-root");
    // Loud, not silent: the refusal names both roots.
    expect(res.detail).toContain(parent);
    expect(res.detail).toContain(child);
    // History outside the run is untouched...
    expect(headSha(parent)).toBe(before);
    // ...and nothing was staged either (the gate runs BEFORE `git add`).
    expect(git(parent, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("REFUSES the end-of-turn backstop commit on the same drift (maybeAutoCommitTurn path)", async () => {
    setCommitRunRoot(child);
    // maybeAutoCommitTurn is hard-disabled under the unit runner so the suite
    // can never commit; lift that for this one call to exercise the real path.
    delete process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const before = headSha(parent);
      writeFileSync(join(parent, "leaked-backstop.ts"), "export const y = 2;\n");

      const res = await maybeAutoCommitTurn({
        cwd: parent,
        dirtyBefore: new Set<string>(),
        userMessage: "do the thing",
      });

      expect(res.committed).toBe(false);
      expect(res.reason).toBe("outside-run-root");
      expect(headSha(parent)).toBe(before);
      expect(git(parent, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    } finally {
      process.env.VITEST = savedEnv.VITEST ?? "1";
      if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    }
  });

  // ---- ordinary use must be completely unaffected ------------------------

  it("ALLOWS a normal same-repo commit (run root == commit repo)", async () => {
    setCommitRunRoot(parent);
    const before = headSha(parent);
    writeFileSync(join(parent, "ok.ts"), "export const ok = 1;\n");

    const res = await commitSpecificPaths(parent, ["ok.ts"], "feat: normal commit");

    expect(res.reason).toBeUndefined();
    expect(res.committed).toBe(true);
    expect(headSha(parent)).not.toBe(before);
    expect(git(parent, ["show", "--stat", "--name-only", "--format=", "HEAD"])).toContain("ok.ts");
  });

  it("ALLOWS a commit after the agent cd'd into a SUB-directory of the same repo", async () => {
    setCommitRunRoot(parent);
    const sub = join(parent, "pkg", "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "deep.ts"), "export const d = 1;\n");
    const before = headSha(parent);

    const res = await commitSpecificPaths(sub, ["deep.ts"], "feat: from a subdir");

    expect(res.committed).toBe(true);
    expect(headSha(parent)).not.toBe(before);
  });

  it("ALLOWS a commit inside the worktree the run was launched in", async () => {
    setCommitRunRoot(child);
    const before = headSha(child);
    writeFileSync(join(child, "inside.ts"), "export const i = 1;\n");

    const res = await commitSpecificPaths(child, ["inside.ts"], "feat: inside the worktree");

    expect(res.committed).toBe(true);
    expect(headSha(child)).not.toBe(before);
    // The parent's branch is still untouched.
    expect(git(parent, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });

  // ---- gate semantics ----------------------------------------------------

  it("verdict carries both roots and flags the mismatch", async () => {
    setCommitRunRoot(child);
    const v = await checkCommitScope(parent);
    expect(v.ok).toBe(false);
    expect(v.expectedRoot).toBe(child);
    expect(v.commitRoot).toBe(parent);
  });

  it("allows anything when the run was NOT launched inside a repo (nothing to confine to)", async () => {
    setCommitRunRoot(root); // temp dir, not a git repo
    const v = await checkCommitScope(parent);
    expect(v.ok).toBe(true);
    expect(v.expectedRoot).toBeNull();
  });

  it("MUONROI_COMMIT_SCOPE=0 is the user escape hatch", async () => {
    setCommitRunRoot(child);
    process.env.MUONROI_COMMIT_SCOPE = "0";
    expect((await checkCommitScope(parent)).ok).toBe(true);
  });

  it("defaults the run root to process.cwd() when nothing pinned it", () => {
    setCommitRunRoot(null);
    expect(getCommitRunRoot()).toBe(process.cwd());
  });
});
