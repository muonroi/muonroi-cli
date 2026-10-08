/**
 * D10 — `buildJudgeDiffSummary` (`sprint-runner.ts`), the judge's diff
 * summary source.
 *
 * Before this fix the call site used a bare `spawnSync("git", ["diff",
 * "--stat", "HEAD"], ...)` wrapped in a try/catch. `spawnSync` reports a
 * spawn-level failure (e.g. `ETIMEDOUT` on a loaded machine) via `.error` on
 * the RETURNED result, not by throwing — so that try/catch never caught it,
 * `stat.stdout` came back `undefined`/empty, and the judge was handed
 * `"(no diff detected)"`: indistinguishable from a genuinely clean diff. This
 * pins the fix: a `runGitSpawn` failure must give `"(diff unavailable)"`, and
 * ONLY a real empty stdout gives `"(no diff detected)"`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/git-spawn.js", () => ({ runGitSpawn: vi.fn() }));

import { runGitSpawn } from "../../utils/git-spawn.js";
import { buildJudgeDiffSummary } from "../sprint-runner.js";

const runGitSpawnMock = runGitSpawn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runGitSpawnMock.mockReset();
});

describe("buildJudgeDiffSummary", () => {
  it("a git spawn failure gives '(diff unavailable)', never '(no diff detected)'", () => {
    runGitSpawnMock.mockReturnValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "spawnSync git ETIMEDOUT",
      attempts: 3,
    });

    const summary = buildJudgeDiffSummary("/repo", 1, "run-x");

    expect(summary).toBe("(diff unavailable)");
    expect(summary).not.toBe("(no diff detected)");
  });

  it("a genuinely empty diff gives '(no diff detected)'", () => {
    runGitSpawnMock.mockReturnValue({ ok: true, stdout: "", stderr: "", attempts: 1 });

    const summary = buildJudgeDiffSummary("/repo", 1, "run-x");

    expect(summary).toBe("(no diff detected)");
  });

  it("a retryable failure that succeeds on attempt 2 returns the real stat output", () => {
    runGitSpawnMock.mockReturnValue({
      ok: true,
      stdout: " src/foo.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
      stderr: "",
      attempts: 2,
    });

    const summary = buildJudgeDiffSummary("/repo", 1, "run-x");

    expect(summary).toContain("src/foo.ts");
  });
});
