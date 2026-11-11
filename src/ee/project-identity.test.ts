import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEERepository } from "./project-identity.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ee-repository-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
const directory = (name: string) => {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
describe("local repository identity", () => {
  it("resolves a git root and stable origin name from nested directories", () => {
    const root = directory("checkout/.git"),
      nested = directory("checkout/src/nested");
    fs.writeFileSync(
      path.join(root, "config"),
      '[remote "origin"]\nurl = https://example.invalid/org/Actual-Repo.git\n',
    );
    expect(resolveEERepository(nested)).toEqual({ root: path.dirname(root), project: "actual-repo" });
  });
  it("resolves common git metadata for worktrees instead of the worktree folder name", () => {
    const common = directory("main/.git"),
      linked = directory("main/.git/worktrees/branch"),
      root = directory("branch-copy");
    fs.writeFileSync(
      path.join(common, "config"),
      '[remote "origin"]\nurl = git@example.invalid:org/canonical-repo.git\n',
    );
    fs.writeFileSync(path.join(linked, "commondir"), "../..\n");
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${linked}\n`);
    expect(resolveEERepository(root)).toEqual({ root, project: "canonical-repo" });
  });
  it.each([
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Library.csproj",
  ])("resolves a real nongit %s project from a subdirectory", (marker) => {
    const root = directory("new-repo"),
      nested = directory("new-repo/src/lib");
    fs.writeFileSync(path.join(root, marker), "{}");
    expect(resolveEERepository(nested)).toEqual({ root, project: "new-repo" });
  });
  it("does not invent scope from an ordinary, nonexistent or relative directory", () => {
    expect(resolveEERepository(directory("ordinary/subdir"))).toBeUndefined();
    expect(resolveEERepository(path.join(home, "absent"))).toBeUndefined();
    expect(resolveEERepository("relative/path")).toBeUndefined();
  });
  it("prefers a nested separate git repository over its registered parent", () => {
    directory("parent/.git");
    const child = directory("parent/child/.git");
    fs.writeFileSync(path.join(child, "config"), '[remote "origin"]\nurl = https://example.invalid/child.git\n');
    expect(resolveEERepository(directory("parent/child/src"))).toEqual({ root: path.dirname(child), project: "child" });
  });
});
