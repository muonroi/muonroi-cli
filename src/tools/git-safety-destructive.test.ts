import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeDestructiveGit, checkDestructiveOp } from "./git-safety.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-destructive-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.ts"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

afterEach(() => {
  delete process.env.MUONROI_ALLOW_DESTRUCTIVE_REVERT;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("analyzeDestructiveGit", () => {
  it("classifies discarding commands", () => {
    expect(analyzeDestructiveGit("git checkout -- src/foo.ts").kind).toBe("checkout-discard");
    expect(analyzeDestructiveGit("git checkout HEAD -- a b c").kind).toBe("checkout-discard");
    expect(analyzeDestructiveGit("git checkout .").kind).toBe("checkout-discard");
    expect(analyzeDestructiveGit("git restore src/foo.ts").kind).toBe("restore");
    expect(analyzeDestructiveGit("git reset --hard HEAD~1").kind).toBe("reset-hard");
    expect(analyzeDestructiveGit("git clean -fd").kind).toBe("clean");
    expect(analyzeDestructiveGit("git stash drop").kind).toBe("stash-drop");
    expect(analyzeDestructiveGit("git stash clear").kind).toBe("stash-drop");
  });

  it("exempts safe forms", () => {
    // Switching branches / creating branches is not a working-tree discard.
    expect(analyzeDestructiveGit("git checkout -b feature").kind).toBeNull();
    expect(analyzeDestructiveGit("git checkout main").kind).toBeNull();
    // `git restore --staged` (no --worktree) only unstages — non-destructive.
    expect(analyzeDestructiveGit("git restore --staged src/foo.ts").kind).toBeNull();
    // `git restore --staged --worktree` DOES discard the working tree.
    expect(analyzeDestructiveGit("git restore --staged --worktree src/foo.ts").kind).toBe("restore");
    // A commit message merely mentioning the words must not trip it.
    expect(analyzeDestructiveGit('git commit -m "reset --hard notes"').kind).toBeNull();
  });
});

describe("checkDestructiveOp", () => {
  it("blocks git checkout -- when the tracked file has uncommitted changes", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "tracked.ts"), "export const a = 2; // edited\n");

    const res = checkDestructiveOp("git checkout -- tracked.ts", dir);
    expect(res.blocked).toBe(true);
    expect(res.kind).toBe("checkout-discard");
    expect(res.message).toContain("tracked.ts");
  });

  it("does NOT block when the working tree is clean (nothing at risk)", () => {
    const dir = makeRepo();
    const res = checkDestructiveOp("git checkout -- tracked.ts", dir);
    expect(res.blocked).toBe(false);
  });

  it("blocks git reset --hard when there are uncommitted changes", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "tracked.ts"), "changed\n");
    expect(checkDestructiveOp("git reset --hard", dir).blocked).toBe(true);
  });

  it("blocks git clean -fd when untracked files exist", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "new-untracked.ts"), "junk\n");
    const res = checkDestructiveOp("git clean -fd", dir);
    expect(res.blocked).toBe(true);
    expect(res.message).toContain("new-untracked.ts");
  });

  it("blocks rm of a tracked file", () => {
    const dir = makeRepo();
    const res = checkDestructiveOp("rm tracked.ts", dir);
    expect(res.blocked).toBe(true);
    expect(res.kind).toBe("rm-tracked");
  });

  it("does NOT block rm of an untracked file", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "scratch.tmp"), "junk\n");
    expect(checkDestructiveOp("rm scratch.tmp", dir).blocked).toBe(false);
  });

  it("respects the MUONROI_ALLOW_DESTRUCTIVE_REVERT escape hatch", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "tracked.ts"), "changed\n");
    process.env.MUONROI_ALLOW_DESTRUCTIVE_REVERT = "1";
    expect(checkDestructiveOp("git reset --hard", dir).blocked).toBe(false);
  });
});
