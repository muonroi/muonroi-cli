/**
 * D10 — the REAL (non-test) diff source `runPlanAdherenceReview` falls back
 * to when no `diffProvider` is injected.
 *
 * Measured defect: sprint 1 of live run `muauw6u93e1c` wrote
 * `sprints/1-adherence.json` with `stopReason: "no_diff"` and `rounds: 0`
 * while the working tree had 3 modified and 3 new files — the plan-adherence
 * review never ran. Root cause: `currentDiff` (the module's private default
 * `getDiff`) called `spawnSync("git", ["diff", "HEAD"], ...)` directly and, on
 * ANY failure (this machine's `debug.log` shows three `ETIMEDOUT` lines that
 * same run), returned `""` from a silent catch — indistinguishable from a
 * genuinely empty diff.
 *
 * `plan-adherence-review.test.ts` covers the injected `diffProvider` path
 * (test-only, byte-identical contract). THIS file covers the DEFAULT path —
 * the one that actually ran in `muauw6u93e1c` — by mocking the shared
 * `runGitSpawn` helper (already unit-pinned for its own retry contract in
 * `src/utils/__tests__/git-spawn.test.ts`). The genuinely-empty-diff case for
 * this same default path is proven against a REAL temp git repo in the
 * sibling file `plan-adherence-review-diff-real.test.ts` (kept separate so
 * this file's module-level `vi.mock` of `git-spawn.js` never has to be
 * unmocked mid-file).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";

vi.mock("../../utils/git-spawn.js", () => ({ runGitSpawn: vi.fn() }));

import { runGitSpawn } from "../../utils/git-spawn.js";
import { type AdherenceVerdict, runPlanAdherenceReview } from "../plan-adherence-review.js";

const runGitSpawnMock = runGitSpawn as unknown as ReturnType<typeof vi.fn>;

async function drain(gen: AsyncGenerator<unknown, AdherenceVerdict, unknown>): Promise<AdherenceVerdict> {
  while (true) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

async function neverCalledReview(): Promise<ToolResult> {
  return { success: true, output: '{"adherent": true, "deviations": []}' };
}

beforeEach(() => {
  runGitSpawnMock.mockReset();
});

describe("runPlanAdherenceReview — default diff source (no diffProvider)", () => {
  it("a git spawn failure gives stopReason 'diff_unavailable', never 'no_diff'", async () => {
    let reviewCalled = false;
    const runIsolatedTask = async (): Promise<ToolResult> => {
      reviewCalled = true;
      return neverCalledReview();
    };
    // Mirrors the live evidence: spawnSync-level ETIMEDOUT — runGitSpawn
    // reports this as ok:false with no stdout.
    runGitSpawnMock.mockReturnValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "spawnSync git ETIMEDOUT",
      attempts: 3,
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan with file_edits",
        cwd: "/repo",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
      }),
    );

    expect(verdict.stopReason).toBe("diff_unavailable");
    expect(verdict.stopReason).not.toBe("no_diff");
    expect(verdict.adherent).toBe(true); // fails open — sprint still continues
    expect(verdict.rounds).toBe(0);
    expect(reviewCalled).toBe(false);
    expect(runGitSpawnMock).toHaveBeenCalledWith(
      ["diff", "HEAD"],
      "/repo",
      expect.any(String),
      expect.any(String),
      undefined,
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
    );
  });

  it("a retryable failure that the shared helper itself resolves on attempt 2 proceeds normally", async () => {
    // runGitSpawn already retries ETIMEDOUT internally (pinned in
    // git-spawn.test.ts); from this call site's perspective that just looks
    // like a successful result with attempts > 1. The review must proceed as
    // if nothing had failed.
    runGitSpawnMock.mockReturnValue({
      ok: true,
      stdout: "diff --git a/x b/x\n+changed\n",
      stderr: "",
      attempts: 2,
    });
    const calls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      calls.push(req);
      return { success: true, output: '{"adherent": true, "deviations": []}' };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan with file_edits",
        cwd: "/repo",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
      }),
    );

    expect(verdict.stopReason).toBe("approved");
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
