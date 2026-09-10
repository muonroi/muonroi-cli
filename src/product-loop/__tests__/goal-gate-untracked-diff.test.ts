/**
 * F5 — the gate must see files git has not been told about yet.
 *
 * `goal-contradiction-gate.test.ts` proves the judge is shown the decisive line
 * of a TRACKED change. That is only half the surface, and the other half was
 * measured failing on a live run.
 *
 * MEASURED, `D:\sources\CompanyLibs\tcis-libraries`, mid-run, after two full
 * sprints of work (read-only probe, no index written):
 *
 *   git diff HEAD              → 5,874 characters
 *   files in it                → .gitignore, Directory.Packages.props, the .sln
 *   contains "TargetFramework" → false
 *   git ls-files --others --exclude-standard → 57 files
 *
 * `git diff HEAD` does not show untracked files. Every file the two sprints
 * actually produced was untracked, and the run never committed (HEAD never
 * moved), so the `HEAD~1..HEAD` fallback never engaged either. The judge was
 * handed ~40 lines of package-version and solution bookkeeping and answered —
 * reasonably — that it was aligned.
 *
 * The second measurement in that probe is why `excludeDir` exists: 49 of those
 * 57 untracked files were the loop's OWN run artifacts. At the gate's 400-char
 * per-file floor, 57 files claim 22,800 characters of a 24,000-character budget,
 * so the loop's bookkeeping would crowd the sprint's actual output down to a few
 * hundred characters each — and, once the gate writes its own verdict into that
 * directory, feed the gate its own output back as "the change that was made".
 *
 * Everything here runs against a REAL repository, because the claim is about
 * what git does, and a stubbed git can only prove what I already believed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffFilePaths, readChangeDiff, runGoalContradictionGate } from "../goal-contradiction-gate.js";
import { F5_GOAL } from "./fixtures/f5-tcis-goal.js";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

/** The user-visible index state. Byte-identical before and after is the claim. */
function porcelain(): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout ?? "";
}

function write(rel: string, contents: string | Buffer): void {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents as never);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "f5-untracked-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "f5@test.local");
  git("config", "user.name", "F5 fixture");
  git("config", "commit.gpgsign", "false");
  write("seed.txt", "seed\n");
  write(".gitignore", "obj/\nbin/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const DECISIVE = "<TargetFramework>net9.0</TargetFramework>";

describe("readChangeDiff — untracked work is part of the change", () => {
  it("shows a brand-new file's content, which `git diff HEAD` alone does not", () => {
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);

    // The premise, measured here rather than asserted from memory.
    const trackedOnly = spawnSync("git", ["diff", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout ?? "";
    expect(trackedOnly.trim()).toBe("");

    const read = readChangeDiff(repo);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.origin).toBe("working-tree");
    expect(read.diff).toContain(`+  ${DECISIVE}`);
    expect(diffFilePaths(read.diff)).toContain("src/new/Project.proj");
  });

  it("keeps a tracked edit AND an untracked addition in the same read", () => {
    write("seed.txt", "seed\nedited\n");
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);

    const read = readChangeDiff(repo);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.diff).toContain("+edited");
    expect(read.diff).toContain(`+  ${DECISIVE}`);
    expect(diffFilePaths(read.diff).sort()).toEqual(["seed.txt", "src/new/Project.proj"]);
  });

  it("does NOT show an ignored path", () => {
    write("obj/Generated.txt", "IGNORED-MARKER-DO-NOT-JUDGE\n");
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);

    const read = readChangeDiff(repo);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.diff).not.toContain("IGNORED-MARKER-DO-NOT-JUDGE");
    expect(diffFilePaths(read.diff)).not.toContain("obj/Generated.txt");
  });

  it("drops the run's own artifact directory when told where it is", () => {
    write(".muonroi-flow/runs/r1/iterations.md", "LOOP-BOOKKEEPING-MARKER\n");
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);

    const withFlow = readChangeDiff(repo);
    expect(withFlow.ok && withFlow.diff).toContain("LOOP-BOOKKEEPING-MARKER");

    const read = readChangeDiff(repo, { excludeDir: join(repo, ".muonroi-flow") });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.diff).not.toContain("LOOP-BOOKKEEPING-MARKER");
    expect(read.diff).toContain(`+  ${DECISIVE}`);
  });

  it("does not spend the budget on a binary blob", () => {
    // 64 KiB of non-text. Handed through verbatim it would be ~87 KiB of base64,
    // 3.6x the whole 24,000-character diff budget, on one file nobody can read.
    const blob = Buffer.alloc(64 * 1024);
    for (let i = 0; i < blob.length; i += 1) blob[i] = i % 251;
    write("assets/blob.bin", blob);
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);

    const read = readChangeDiff(repo);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.diff).toContain("assets/blob.bin");
    expect(read.diff).toMatch(/Binary files/);
    expect(read.diff.length).toBeLessThan(4_000);
    // The readable file is still there — the blob did not crowd it out.
    expect(read.diff).toContain(`+  ${DECISIVE}`);
  });

  it("leaves the index of the repository under test exactly as it found it", async () => {
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);
    write("obj/Generated.txt", "ignored\n");
    const before = porcelain();

    readChangeDiff(repo);
    await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: repo,
      llm: { generate: vi.fn(async () => '```goal-check\n{"verdict":"aligned","contradictions":[]}\n```') },
      modelId: "fixture-judge-model",
    });

    // `git add -N` would rewrite these lines from `??` to `A ` / ` M`. A gate that
    // reads a customer's repository mid-run must stay read-only, so the assertion
    // is on what the user would see, not on an internal flag.
    expect(porcelain()).toBe(before);
    expect(before).toContain("?? src/");
  });

  it("stops at the file cap instead of rendering an unbounded tree", () => {
    for (let i = 0; i < 5; i += 1) write(`src/f${i}.txt`, `file ${i}\n`);

    // The shipped cap is 200 files; proving the boundary engages does not
    // require 200 real files and 200 real processes, only that the cap is read.
    const read = readChangeDiff(repo, { maxUntrackedFiles: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(diffFilePaths(read.diff)).toHaveLength(2);
  });

  it("still reports no-diff when nothing changed at all", () => {
    const read = readChangeDiff(repo);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The two facts stay separate: "nothing was changed" is not "we cannot tell".
    expect(read.reason).toBe("no-diff");
  });

  it("still reports diff-unreadable outside a repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "f5-norepo-"));
    try {
      const read = readChangeDiff(notARepo);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toBe("diff-unreadable");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("the untracked work reaches the judge's prompt", () => {
  it("puts a never-committed file's decisive line in front of the judge", async () => {
    write("src/new/Project.proj", `<Project>\n  ${DECISIVE}\n</Project>\n`);
    let prompt = "";

    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: repo,
      llm: { generate: vi.fn(async () => '```goal-check\n{"verdict":"aligned","contradictions":[]}\n```') },
      modelId: "fixture-judge-model",
      onPrompt: (p) => {
        prompt = p;
      },
    });

    expect(prompt).toContain(DECISIVE);
    expect(out.source).toBe("aligned");
    // What the judge was shown is reported back, so a diff that contains only
    // bookkeeping is visible without re-running the gate.
    expect(out.diffFiles).toContain("src/new/Project.proj");
    expect(out.diffChars).toBeGreaterThan(0);
  });
});
