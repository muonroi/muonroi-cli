/**
 * F5/K — the gate must judge THE SPRINT'S CHANGE, not whichever half of it
 * happens to be non-empty.
 *
 * `goal-gate-untracked-diff.test.ts` closed the enumeration door (untracked
 * files were invisible). This closes the SCOPE door, which the same rubber
 * stamp walks through: the read picked ONE source and the other was discarded.
 *
 * MEASURED, run `muc2joffe506` sprint 2, 2026-09-25,
 * `.muonroi-flow/runs/muc2joffe506/sprints/2-goal-gate.json` verbatim:
 *
 *   "fired": false, "source": "aligned",
 *   "detail": "The change adds test artifacts and a timestamp update, which do
 *              not hinder the goal of porting a new project.",
 *   "diffOrigin": "working-tree",
 *   "diffFiles": [".muonroi-flow/runs/muc2joffe506/verify-baseline.json",
 *                 "backend/test_artifacts.db",
 *                 "specs/040-sprint1-artifact-store/tests/_smoke_test.db",
 *                 "test_artifacts.db"],
 *   "diffChars": 1103
 *
 * while `git log` over the same window shows the sprint COMMITTED real work
 * (`7384a88`, `3965a9a`, `3153d8d`, `94a6557`, …). 1103 characters of leftover
 * test databases were judged, found harmless — correctly, about those files —
 * and the sprint was reported aligned with the gate blind to every line of the
 * work. A gate that reports PASS on nothing manufactures evidence of alignment.
 *
 * Two independent causes, both pinned below:
 *
 *  1. the working tree won UNCONDITIONALLY when non-empty, so four stray `.db`
 *     files were enough to hide four commits. `last-commit` was reachable only
 *     from a perfectly clean tree, which a sprint that writes any artifact
 *     never has.
 *  2. the committed half was `HEAD~1..HEAD` — ONE commit. Even from a clean
 *     tree the gate would have judged `7384a88` alone and missed the other
 *     three. It had no concept of *the sprint's* changes.
 *
 * Everything here runs against a REAL repository with REAL commits, because
 * the claim is about what git reports over a range, and a stubbed git can only
 * prove what I already believed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffFilePaths, readChangeDiff, runGoalContradictionGate } from "../goal-contradiction-gate.js";
import { F5_GOAL } from "./fixtures/f5-tcis-goal.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function write(rel: string, contents: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

/** The sprint's four source commits, named after the measured ones. */
const SPRINT_COMMITS = [
  {
    file: "backend/shared/artifact_store.py",
    line: "ARTIFACT_STORE_REGISTERED = True",
    msg: "chore: update 2 file(s)",
  },
  {
    file: "backend/sprint2_deviations.py",
    line: "DEVIATIONS_ADDRESSED = 15",
    msg: "fix(sprint2): address 15 deviations",
  },
  { file: "backend/shared/contracts/__init__.py", line: "NO_BAK_STUBS = True", msg: "refactor: remove .bak stubs" },
  { file: "ci/verify.sh", line: "echo 'all 5 checks PASS'", msg: "ci(verify): run CI verify gates" },
] as const;

/** The leftover test databases and timestamp bump that were judged INSTEAD. */
function writeTheArtifactsThatHidTheWork(): void {
  write(".muonroi-flow/runs/muc2joffe506/verify-baseline.json", '{"capturedAtUtc":"2026-09-25T06:10:03.320Z"}\n');
  write("backend/test_artifacts.db", "SQLite format 3\u0000ARTIFACT-DB-NOISE\n");
  write("specs/040-sprint1-artifact-store/tests/_smoke_test.db", "SQLite format 3\u0000SMOKE-DB-NOISE\n");
  write("test_artifacts.db", "SQLite format 3\u0000ROOT-DB-NOISE\n");
}

/** Commit the sprint's work; return the SHA the sprint STARTED from. */
function commitTheSprintsWork(): string {
  const base = git("rev-parse", "HEAD").trim();
  for (const c of SPRINT_COMMITS) {
    write(c.file, `${c.line}\n`);
    git("add", "--", c.file);
    git("commit", "-q", "-m", c.msg);
  }
  return base;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "f5-sprint-scope-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "f5@test.local");
  git("config", "user.name", "F5 fixture");
  git("config", "commit.gpgsign", "false");
  write("seed.txt", "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // A second pre-sprint commit, so "the sprint base" and "the repo's first
  // commit" are never the same SHA by accident.
  write("README.md", "pre-existing\n");
  git("add", "-A");
  git("commit", "-q", "-m", "pre-sprint work");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("readChangeDiff — the sprint's commits are part of the change", () => {
  it("does not let four stray artifacts hide four commits (the measured muc2joffe506 defect)", () => {
    const base = commitTheSprintsWork();
    writeTheArtifactsThatHidTheWork();

    // The premise, measured here rather than asserted from memory: the working
    // tree IS non-empty, and holds nothing but the artifacts.
    const worktreeOnly = git("status", "--porcelain");
    expect(worktreeOnly).toContain("test_artifacts.db");

    const read = readChangeDiff(repo, { sinceCommit: base, excludeDir: join(repo, ".muonroi-flow") });
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // EVERY committed source line reaches the judge — not just the last one.
    for (const c of SPRINT_COMMITS) {
      expect(read.diff).toContain(`+${c.line}`);
      expect(diffFilePaths(read.diff)).toContain(c.file);
    }
    // …and the artifacts are still there. They were never the problem; the
    // missing commits were. Nothing here filters them out.
    expect(diffFilePaths(read.diff)).toContain("test_artifacts.db");
    // The origin names BOTH halves, because both were read.
    expect(read.origin).toBe("sprint-commits+working-tree");
  });

  it("judges every commit of the sprint from a clean tree, not only HEAD~1..HEAD", () => {
    const base = commitTheSprintsWork();
    expect(git("status", "--porcelain").trim()).toBe("");

    const read = readChangeDiff(repo, { sinceCommit: base });
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // The FIRST of the four commits is the one `HEAD~1..HEAD` could never see.
    expect(read.diff).toContain(`+${SPRINT_COMMITS[0].line}`);
    expect(read.diff).toContain(`+${SPRINT_COMMITS[3].line}`);
    expect(read.origin).toBe("sprint-commits");
  });

  it("with no recorded base, a bounded commit range still sees more than one commit", () => {
    commitTheSprintsWork();
    expect(git("status", "--porcelain").trim()).toBe("");

    // No `sinceCommit` — the honest fallback is a BOUNDED range with a named
    // limit, never a silent HEAD~1.
    const read = readChangeDiff(repo);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.diff).toContain(`+${SPRINT_COMMITS[0].line}`);
    expect(read.diff).toContain(`+${SPRINT_COMMITS[3].line}`);
    // Named for what was actually read: a bounded range of recent commits,
    // which may reach back past this sprint. It is NOT "the last commit".
    expect(read.origin).toBe("recent-commits");
  });

  it("the excluded run-artifact directory stays excluded from the COMMITTED half too", () => {
    // The loop's own paperwork gets committed by auto-commit on real runs, so an
    // exclusion that only covers untracked files leaks it straight back in.
    const base = git("rev-parse", "HEAD").trim();
    write(".muonroi-flow/runs/r1/iterations.md", "LOOP-BOOKKEEPING-MARKER\n");
    write("src/real.py", "REAL_WORK = 1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "sprint work plus the loop's own paperwork");

    const read = readChangeDiff(repo, { sinceCommit: base, excludeDir: join(repo, ".muonroi-flow") });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.diff).toContain("+REAL_WORK = 1");
    expect(read.diff).not.toContain("LOOP-BOOKKEEPING-MARKER");
  });
});

describe("a base that cannot be resolved never reads as 'aligned'", () => {
  it("falls back to the bounded range when the recorded base is not an ancestor of HEAD", () => {
    commitTheSprintsWork();

    // A SHA of the right shape that this repository has never heard of — the
    // shape of a baseline written on another branch, another checkout, or before
    // a history rewrite. Stale garbage, not knowledge.
    const read = readChangeDiff(repo, { sinceCommit: "0".repeat(40) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Degraded to the bounded range, and the origin SAYS so rather than
    // claiming a sprint base was honoured.
    expect(read.origin).toBe("recent-commits");
    expect(read.diff).toContain(`+${SPRINT_COMMITS[0].line}`);
  });

  it("reports diff-unreadable — never 'aligned' — when the change cannot be determined at all", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "f5-sprint-norepo-"));
    try {
      const generate = vi.fn(async () => '```goal-check\n{"verdict":"aligned","contradictions":[]}\n```');
      const out = await runGoalContradictionGate({
        goal: F5_GOAL,
        cwd: notARepo,
        sinceCommit: "0".repeat(40),
        llm: { generate },
        modelId: "fixture-judge-model",
      });

      // The defect class in one assertion: a gate that cannot determine what
      // changed must not report the change aligned.
      expect(out.source).toBe("diff-unreadable");
      expect(out.source).not.toBe("aligned");
      expect(out.fired).toBe(false);
      // …and it never even asked. An "aligned" it could have printed would have
      // been a verdict about nothing.
      expect(generate).not.toHaveBeenCalled();
      expect(out.diffOrigin).toBeUndefined();
    } finally {
      rmSync(notARepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("still reports no-diff when the tree is clean and the sprint committed nothing", () => {
    const base = git("rev-parse", "HEAD").trim();

    const read = readChangeDiff(repo, { sinceCommit: base });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // "nothing was changed" and "we cannot tell" stay separate facts.
    expect(read.reason).toBe("no-diff");
  });
});

describe("the sprint's committed work reaches the judge's prompt", () => {
  it("puts a COMMITTED source line in front of the judge while the tree holds only artifacts", async () => {
    const base = commitTheSprintsWork();
    writeTheArtifactsThatHidTheWork();
    let prompt = "";

    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: repo,
      sinceCommit: base,
      excludeDir: join(repo, ".muonroi-flow"),
      llm: { generate: vi.fn(async () => '```goal-check\n{"verdict":"aligned","contradictions":[]}\n```') },
      modelId: "fixture-judge-model",
      onPrompt: (p) => {
        prompt = p;
      },
    });

    for (const c of SPRINT_COMMITS) expect(prompt).toContain(c.line);
    expect(out.diffOrigin).toBe("sprint-commits+working-tree");
    // The pair that made the rubber stamp visible on sight now names the work,
    // not only the leftovers: the measured record listed FOUR artifact paths and
    // 1103 characters next to an "aligned".
    expect(out.diffFiles).toContain(SPRINT_COMMITS[0].file);
    expect(out.diffChars).toBeGreaterThan(0);
  });
});
