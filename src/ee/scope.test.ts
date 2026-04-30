import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test the module under test after creating it
import { buildScope, resetScopeCache, scopeLabel } from "./scope.js";

describe("buildScope", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetScopeCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns { kind: 'global' } for a directory without .git", async () => {
    const scope = await buildScope({ cwd: tmpDir });
    expect(scope).toEqual({ kind: "global" });
  });

  it("returns { kind: 'repo', remote } on detached HEAD with remote origin", async () => {
    const gitDir = path.join(tmpDir, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "abc123deadbeef\n");
    await fs.writeFile(
      path.join(gitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/foo/bar.git\n',
    );
    const scope = await buildScope({ cwd: tmpDir });
    expect(scope).toEqual({
      kind: "repo",
      remote: "https://github.com/foo/bar.git",
    });
  });

  it("returns { kind: 'branch', remote, branch } when HEAD points to ref", async () => {
    const gitDir = path.join(tmpDir, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(
      path.join(gitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/foo/bar.git\n',
    );
    const scope = await buildScope({ cwd: tmpDir });
    expect(scope).toEqual({
      kind: "branch",
      remote: "https://github.com/foo/bar.git",
      branch: "main",
    });
  });

  it("reads .git/HEAD + .git/config via fs (no child_process spawn)", async () => {
    // Verify the module source does not import child_process
    const source = await fs.readFile(
      path.join(process.cwd(), "src/ee/scope.ts"),
      "utf8",
    );
    // Check for import/require of child_process (not just mentions in comments)
    expect(source).not.toMatch(/import.*child_process/);
    expect(source).not.toMatch(/require.*child_process/);
    expect(source).not.toMatch(/import.*\bspawn\b/);
    expect(source).not.toMatch(/import.*\bexec\b/);
  });

  it("caches: second call returns same object reference", async () => {
    const gitDir = path.join(tmpDir, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/dev\n");
    await fs.writeFile(
      path.join(gitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/a/b.git\n',
    );
    const first = await buildScope({ cwd: tmpDir });
    const second = await buildScope({ cwd: tmpDir });
    expect(first).toBe(second); // same reference
  });

  it("resetScopeCache forces re-read", async () => {
    const gitDir = path.join(tmpDir, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/dev\n");
    await fs.writeFile(
      path.join(gitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/a/b.git\n',
    );
    const first = await buildScope({ cwd: tmpDir });
    resetScopeCache();
    // Change the branch
    await fs.writeFile(
      path.join(gitDir, "HEAD"),
      "ref: refs/heads/feature\n",
    );
    const second = await buildScope({ cwd: tmpDir });
    expect(first).not.toBe(second);
    expect(second).toEqual({
      kind: "branch",
      remote: "https://github.com/a/b.git",
      branch: "feature",
    });
  });
});

describe("scopeLabel", () => {
  it("formats global scope", () => {
    expect(scopeLabel({ kind: "global" })).toBe("global");
  });

  it("formats ecosystem scope", () => {
    expect(scopeLabel({ kind: "ecosystem", name: "muonroi" })).toBe(
      "ecosystem:muonroi",
    );
  });

  it("formats repo scope", () => {
    expect(scopeLabel({ kind: "repo", remote: "https://github.com/x/y" })).toBe(
      "repo:https://github.com/x/y",
    );
  });

  it("formats branch scope", () => {
    expect(
      scopeLabel({
        kind: "branch",
        remote: "https://github.com/x/y",
        branch: "main",
      }),
    ).toBe("branch:https://github.com/x/y#main");
  });
});
