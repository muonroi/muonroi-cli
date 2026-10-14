/**
 * D10 — `readChangeDiff`'s committed-half fallback (`goal-contradiction-gate.ts`)
 * used to collapse EVERY failure of that git call into `reason: "no-diff"`:
 * `committed.ok ? "no changes since HEAD" : committed.detail` never checked
 * WHY `committed.ok` was false. One reason is genuinely benign — this is the
 * repo's first commit, so there is no prior commit to diff against, which
 * `goal-gate-untracked-diff.test.ts` pins as `"no-diff"` against a REAL repo.
 * But a git spawn FAILURE (e.g. `ETIMEDOUT` on a loaded machine, the same
 * class of defect as the other two D10 call sites) is not that — it is "we
 * cannot tell", and must surface as `"diff-unreadable"`.
 *
 * Every fact gets proven against the same fixture: an empty working tree and
 * no untracked files (so the worktree/untracked reads both legitimately
 * succeed empty and the code reaches the committed half at all), with the
 * committed read mocked to fail for a REASON OTHER THAN "no prior commit" —
 * proving the fix does not just blanket-relabel every failure.
 *
 * F5/K — the fallback is no longer a bare `HEAD~1..HEAD`; it is a BOUNDED range
 * (`GOAL_GATE_FALLBACK_COMMIT_DEPTH`) clamped by `rev-list --count` to the
 * commits that exist, because a one-commit window was blind to three of a
 * sprint's four commits. So the mock now answers that count too, and the same
 * two facts are additionally pinned at the NEW boundary: an unreadable count is
 * "we cannot tell", and a count of exactly 1 is the deterministic "there is no
 * prior commit".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/git-spawn.js", () => ({
  runGitSpawn: vi.fn(),
  createGitSpawnBudget: vi.fn(() => ({ deadlineAt: Date.now() + 60_000 })),
}));

import { runGitSpawn } from "../../utils/git-spawn.js";
import { GOAL_GATE_FALLBACK_COMMIT_DEPTH, readChangeDiff } from "../goal-contradiction-gate.js";

const runGitSpawnMock = runGitSpawn as unknown as ReturnType<typeof vi.fn>;

const ok = (stdout = "") => ({ ok: true, stdout, stderr: "", attempts: 1 });

/**
 * The reads that must legitimately succeed EMPTY for the committed half to be
 * reached at all: a clean working tree and no untracked files.
 *
 * `committed` answers everything the committed half asks; anything it returns
 * `undefined` for is an unexpected git call and fails the test loudly, which is
 * what caught this fixture up with the bounded range in the first place.
 */
function mockGit(committed: (args: string[]) => object | undefined): void {
  runGitSpawnMock.mockImplementation((args: string[]) => {
    if (args[0] === "diff" && args[1] === "HEAD") return ok(); // worktree: empty
    if (args[0] === "ls-files") return ok(); // untracked: none
    const answer = committed(args);
    if (answer) return answer;
    throw new Error(`unexpected git args in test: ${args.join(" ")}`);
  });
}

/** A commit count high enough that the range is the depth, not the clamp. */
const PLENTY = String(GOAL_GATE_FALLBACK_COMMIT_DEPTH + 1);
const RANGE = `HEAD~${GOAL_GATE_FALLBACK_COMMIT_DEPTH}`;

beforeEach(() => {
  runGitSpawnMock.mockReset();
});

describe("readChangeDiff — the bounded committed-range fallback", () => {
  it("a spawn failure on the range diff gives 'diff-unreadable', not 'no-diff'", () => {
    mockGit((args) => {
      if (args[0] === "rev-list") return ok(`${PLENTY}\n`);
      if (args[0] === "diff" && args[1] === RANGE) {
        // A spawn-level failure — NOT "no such revision", a genuine infra problem.
        return { ok: false, stdout: "", stderr: "", error: "spawnSync git ETIMEDOUT", attempts: 3 };
      }
      return undefined;
    });

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("diff-unreadable");
    expect(read.detail).toContain("ETIMEDOUT");
  });

  it("the 'unknown revision' git verdict on the range diff still gives 'no-diff'", () => {
    mockGit((args) => {
      if (args[0] === "rev-list") return ok(`${PLENTY}\n`);
      if (args[0] === "diff" && args[1] === RANGE) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          error: `git diff ${RANGE} HEAD exited 128: fatal: ambiguous argument '${RANGE}': unknown revision or path not in the working tree.`,
          attempts: 1,
        };
      }
      return undefined;
    });

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("no-diff");
  });

  it("an unreadable commit COUNT is 'we cannot tell', never 'nothing changed'", () => {
    // The clamp is a new place the read can fail, so it gets the same rule: a
    // count we could not take says nothing about whether commits exist.
    mockGit((args) => {
      if (args[0] === "rev-list") {
        return { ok: false, stdout: "", stderr: "", error: "spawnSync git ETIMEDOUT", attempts: 3 };
      }
      return undefined;
    });

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("diff-unreadable");
    expect(read.detail).toContain("ETIMEDOUT");
  });

  it("a count of exactly 1 is the deterministic 'no prior commit' — 'no-diff', and no range diff is attempted", () => {
    // The clamp replaces what used to be discovered by letting `HEAD~1` fail.
    // A range diff here would be asking git for a revision we already know is
    // not there, so the mock fails the test if one is attempted.
    mockGit((args) => (args[0] === "rev-list" ? ok("1\n") : undefined));

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("no-diff");
  });

  it("an unparseable commit count is 'we cannot tell' rather than a NaN-deep range", () => {
    mockGit((args) => (args[0] === "rev-list" ? ok("not a number\n") : undefined));

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("diff-unreadable");
  });

  it("a recorded base that git cannot resolve degrades to the bounded range, not to a pass", () => {
    // `merge-base --is-ancestor` exits 128 on an unknown name and 1 on a real
    // non-ancestor; both arrive as `!ok` and both mean the SHA cannot describe
    // where the work started.
    mockGit((args) => {
      if (args[0] === "merge-base") {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          error: "git merge-base --is-ancestor exited 128: fatal: Not a valid commit name deadbeef",
          attempts: 1,
        };
      }
      if (args[0] === "rev-list") return ok(`${PLENTY}\n`);
      if (args[0] === "diff" && args[1] === RANGE) return ok("diff --git a/x b/x\n+committed\n");
      return undefined;
    });

    const read = readChangeDiff("/repo", { sinceCommit: "deadbeef" });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.origin).toBe("recent-commits");
    expect(read.diff).toContain("+committed");
  });

  it("a failed diff against a VALID recorded base is 'we cannot tell', not a silent fallback", () => {
    // Degrading to the bounded range here would hide an infrastructure failure
    // behind a different, wider answer. The base resolved; the read did not.
    mockGit((args) => {
      if (args[0] === "merge-base") return ok();
      if (args[0] === "diff" && args[1] === "abc1234") {
        return { ok: false, stdout: "", stderr: "", error: "spawnSync git ETIMEDOUT", attempts: 3 };
      }
      return undefined;
    });

    const read = readChangeDiff("/repo", { sinceCommit: "abc1234" });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("diff-unreadable");
    expect(read.detail).toContain("abc1234..HEAD");
  });
});
