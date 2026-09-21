/**
 * D10 — `readChangeDiff`'s `HEAD~1..HEAD` fallback (`goal-contradiction-gate.ts`)
 * used to collapse EVERY failure of that git call into `reason: "no-diff"`:
 * `committed.ok ? "no changes since HEAD" : committed.detail` never checked
 * WHY `committed.ok` was false. One reason is genuinely benign — this is the
 * repo's first commit, so there is no `HEAD~1` to diff against, which
 * `goal-gate-untracked-diff.test.ts` pins as `"no-diff"` against a REAL repo.
 * But a git spawn FAILURE (e.g. `ETIMEDOUT` on a loaded machine, the same
 * class of defect as the other two D10 call sites) is not that — it is "we
 * cannot tell", and must surface as `"diff-unreadable"`.
 *
 * Both facts get proven against the same fixture: an empty working tree and
 * no untracked files (so the worktree/untracked reads both legitimately
 * succeed empty and the code reaches this fallback at all), with the
 * `HEAD~1..HEAD` call itself mocked to fail for a REASON OTHER THAN "no
 * HEAD~1" — proving the fix does not just blanket-relabel every failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/git-spawn.js", () => ({
  runGitSpawn: vi.fn(),
  createGitSpawnBudget: vi.fn(() => ({ deadlineAt: Date.now() + 60_000 })),
}));

import { runGitSpawn } from "../../utils/git-spawn.js";
import { readChangeDiff } from "../goal-contradiction-gate.js";

const runGitSpawnMock = runGitSpawn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runGitSpawnMock.mockReset();
});

describe("readChangeDiff — the HEAD~1..HEAD fallback", () => {
  it("a spawn failure on the fallback gives 'diff-unreadable', not 'no-diff'", () => {
    runGitSpawnMock.mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args[1] === "HEAD") {
        return { ok: true, stdout: "", stderr: "", attempts: 1 }; // worktree: empty
      }
      if (args[0] === "ls-files") {
        return { ok: true, stdout: "", stderr: "", attempts: 1 }; // untracked: none
      }
      if (args[0] === "diff" && args[1] === "HEAD~1") {
        // A spawn-level failure — NOT "no HEAD~1", a genuine infra problem.
        return { ok: false, stdout: "", stderr: "", error: "spawnSync git ETIMEDOUT", attempts: 3 };
      }
      throw new Error(`unexpected git args in test: ${args.join(" ")}`);
    });

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("diff-unreadable");
    expect(read.detail).toContain("ETIMEDOUT");
  });

  it("the 'no HEAD~1' git verdict on the fallback still gives 'no-diff'", () => {
    runGitSpawnMock.mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args[1] === "HEAD") {
        return { ok: true, stdout: "", stderr: "", attempts: 1 };
      }
      if (args[0] === "ls-files") {
        return { ok: true, stdout: "", stderr: "", attempts: 1 };
      }
      if (args[0] === "diff" && args[1] === "HEAD~1") {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          error:
            "git diff HEAD~1 HEAD exited 128: fatal: ambiguous argument 'HEAD~1': unknown revision or path not in the working tree.",
          attempts: 1,
        };
      }
      throw new Error(`unexpected git args in test: ${args.join(" ")}`);
    });

    const read = readChangeDiff("/repo");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("no-diff");
  });
});
