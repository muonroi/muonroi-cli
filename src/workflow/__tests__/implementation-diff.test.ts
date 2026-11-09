import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flowStateExcludePathspecs, readImplementationDiff } from "../workflow-tools.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
}

/** Real temp git repo whose tracked tree holds a source file plus FLOW state files. */
function makeRepo(stateRel: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "flow-implrdiff-"));
  git(cwd, "init", "-q");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, stateRel), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, stateRel, "ROADMAP.md"), "# Roadmap\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "init");
  return cwd;
}

describe("readImplementationDiff", () => {
  const dirs: string[] = [];
  let savedStateDir: string | undefined;
  beforeEach(() => {
    savedStateDir = process.env.MUONROI_STATE_DIR;
    delete process.env.MUONROI_STATE_DIR;
  });
  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.MUONROI_STATE_DIR;
    else process.env.MUONROI_STATE_DIR = savedStateDir;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  for (const stateRel of [".planning", ".muonroi-flow/planning"]) {
    it(`excludes a modified tracked file under ${stateRel} but keeps modified source`, () => {
      const cwd = makeRepo(stateRel);
      dirs.push(cwd);
      writeFileSync(join(cwd, stateRel, "ROADMAP.md"), "# Roadmap\n## Phase 20\n[To be planned]\n");
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 2;\n");

      const diff = readImplementationDiff(cwd);
      expect(diff).toContain("src/a.ts");
      expect(diff).toContain("+export const a = 2;");
      expect(diff).not.toContain("ROADMAP.md");
      expect(diff).not.toContain("[To be planned]");
    });
  }

  it("is empty when only the planning state changed (analysis deliverable)", () => {
    const cwd = makeRepo(".planning");
    dirs.push(cwd);
    writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# Roadmap\n## Phase 20\n");
    expect(readImplementationDiff(cwd).trim()).toBe("");
  });

  it("also excludes .muonroi-flow/ when the planning root is .planning", () => {
    const cwd = makeRepo(".planning");
    dirs.push(cwd);
    mkdirSync(join(cwd, ".muonroi-flow", "runs"), { recursive: true });
    writeFileSync(join(cwd, ".muonroi-flow", "runs", "r.json"), "{}\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "flow");
    writeFileSync(join(cwd, ".muonroi-flow", "runs", "r.json"), '{"x":1}\n');
    expect(readImplementationDiff(cwd).trim()).toBe("");
  });

  it("needs no exclude for a planning root outside the repo (MUONROI_STATE_DIR)", () => {
    const cwd = makeRepo(".planning");
    dirs.push(cwd);
    const outside = mkdtempSync(join(tmpdir(), "flow-implrdiff-state-"));
    dirs.push(outside);
    process.env.MUONROI_STATE_DIR = outside;
    expect(flowStateExcludePathspecs(cwd)).toEqual([":(top,exclude).muonroi-flow"]);
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 3;\n");
    expect(readImplementationDiff(cwd)).toContain("+export const a = 3;");
  });

  it("returns an unavailable marker, not an empty diff (never throws), outside a git repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "flow-implrdiff-nogit-"));
    dirs.push(cwd);
    const diff = readImplementationDiff(cwd);
    expect(diff.startsWith("(implementation diff unavailable: git diff failed: ")).toBe(true);
    expect(diff.trim()).not.toBe("");
  });
});
