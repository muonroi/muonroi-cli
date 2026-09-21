/**
 * D10 — the genuinely-empty-diff case for `runPlanAdherenceReview`'s DEFAULT
 * (non-test) diff source, proven against a real temp git repo end to end
 * (no mocks) so the wiring from `runPlanAdherenceReview` through
 * `currentDiffResult` to the real `git diff HEAD` is exercised for real.
 *
 * Kept in its own file (rather than folded into
 * `plan-adherence-review-diff-source.test.ts`) because that sibling file
 * mocks `../../utils/git-spawn.js` at module scope — mixing a real git spawn
 * into the same file would require unmocking mid-file, which is fragile.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../../types/index.js";
import { type AdherenceVerdict, runPlanAdherenceReview } from "../plan-adherence-review.js";

async function drain(gen: AsyncGenerator<unknown, AdherenceVerdict, unknown>): Promise<AdherenceVerdict> {
  while (true) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

describe("runPlanAdherenceReview — default diff source against a real repo", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "d10-adherence-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "d10@test.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "D10 fixture"], { cwd: repo });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "seed"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("a genuinely empty diff still gives stopReason 'no_diff' through the REAL default path", async () => {
    let called = false;
    const runIsolatedTask = async (): Promise<ToolResult> => {
      called = true;
      return { success: true, output: "{}" };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan",
        cwd: repo,
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
      }),
    );

    expect(verdict.stopReason).toBe("no_diff");
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(0);
    expect(called).toBe(false);
  });
});
