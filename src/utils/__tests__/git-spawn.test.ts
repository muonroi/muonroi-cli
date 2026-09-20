/**
 * git-spawn.test.ts — D7.
 *
 * Pins the shared `runGitSpawn` helper's retry contract: a spawn-level
 * failure (ETIMEDOUT / EAGAIN / ENOMEM) is retried with backoff, a genuine
 * non-zero git exit is NEVER retried, exhausted retries degrade with the
 * same result shape as a single failure, the per-attempt timeout env
 * override validates the same way `getNoProgressSprintLimit` does — AND
 * (acceptance-review fix) the TOTAL elapsed budget across attempts stops
 * retrying even on a retryable error, and a `GitSpawnBudget` shared across
 * several sequential calls stops the LATER calls early once it is spent.
 */
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

import { getGitSpawnTimeoutMs, getGitSpawnTotalBudgetMs, runGitSpawn } from "../git-spawn.js";

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

function timeoutError(): NodeJS.ErrnoException {
  const err = new Error("spawnSync git ETIMEDOUT") as NodeJS.ErrnoException;
  err.code = "ETIMEDOUT";
  return err;
}

const ORIGINAL_TIMEOUT_ENV = process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS;
const ORIGINAL_BUDGET_ENV = process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS;

beforeEach(() => {
  spawnSyncMock.mockReset();
  delete process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS;
  delete process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS;
});

afterEach(() => {
  if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS;
  else process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
  if (ORIGINAL_BUDGET_ENV === undefined) delete process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS;
  else process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS = ORIGINAL_BUDGET_ENV;
  vi.restoreAllMocks();
});

describe("getGitSpawnTimeoutMs", () => {
  it("returns the default (20000ms) when unset", () => {
    expect(getGitSpawnTimeoutMs()).toBe(20_000);
  });

  it("honours a valid override", () => {
    process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS = "9000";
    expect(getGitSpawnTimeoutMs()).toBe(9000);
  });

  it("ignores an invalid override and logs why", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS = "not-a-number";
    expect(getGitSpawnTimeoutMs()).toBe(20_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores a non-positive override", () => {
    process.env.MUONROI_GIT_SPAWN_TIMEOUT_MS = "-5";
    expect(getGitSpawnTimeoutMs()).toBe(20_000);
  });
});

describe("getGitSpawnTotalBudgetMs", () => {
  it("returns the default (60000ms) when unset", () => {
    expect(getGitSpawnTotalBudgetMs()).toBe(60_000);
  });

  it("honours a valid override", () => {
    process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS = "30000";
    expect(getGitSpawnTotalBudgetMs()).toBe(30_000);
  });

  it("ignores an invalid override and logs why", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS = "not-a-number";
    expect(getGitSpawnTotalBudgetMs()).toBe(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores a non-positive override", () => {
    process.env.MUONROI_GIT_SPAWN_TOTAL_BUDGET_MS = "0";
    expect(getGitSpawnTotalBudgetMs()).toBe(60_000);
  });
});

describe("runGitSpawn", () => {
  it("a first-attempt ETIMEDOUT (spawn-level) followed by success returns the value", () => {
    spawnSyncMock
      .mockReturnValueOnce({ error: timeoutError(), status: null, stdout: "", stderr: "" })
      .mockReturnValueOnce({ error: undefined, status: 0, stdout: "abc123\n", stderr: "" });

    const result = runGitSpawn(["rev-parse", "HEAD"], "/tmp/repo", "readGitIdentity", "test");

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("abc123\n");
    expect(result.attempts).toBe(2);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("a genuine non-zero git exit is NEVER retried", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const result = runGitSpawn(["rev-parse", "HEAD"], "/tmp/not-a-repo", "readGitIdentity", "test");

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("exited 128");
  });

  it("exhausted retries degrade honestly, with the same result shape as a single failure", () => {
    spawnSyncMock.mockReturnValue({ error: timeoutError(), status: null, stdout: "", stderr: "" });

    const result = runGitSpawn(["status", "--porcelain"], "/tmp/repo", "computeAddedFilesSinceBaseline", "test");

    expect(result.ok).toBe(false);
    expect(result.stdout).toBe("");
    expect(typeof result.error).toBe("string");
    // 1 initial attempt + 2 retries = 3 total.
    expect(result.attempts).toBe(3);
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("a non-retryable spawn error code (e.g. ENOENT — git not installed) is not retried", () => {
    const err = new Error("spawnSync git ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    spawnSyncMock.mockReturnValue({ error: err, status: null, stdout: "", stderr: "" });

    const result = runGitSpawn(["rev-parse", "HEAD"], "/tmp/repo", "readGitIdentity", "test");

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  // ── Total elapsed budget (acceptance-review fix) ──────────────────────────
  // A per-attempt timeout alone is not enough: 3 attempts x a generous
  // per-attempt timeout can block the single JS thread for minutes. These
  // tests control `Date.now()` directly (rather than the per-attempt
  // `timeout` passed to `spawnSync`, which the mock ignores) so the budget
  // math is exercised deterministically, with no real waiting.

  it("the total budget stops retrying even when the error is retryable", () => {
    spawnSyncMock.mockReturnValue({ error: timeoutError(), status: null, stdout: "", stderr: "" });
    // Attempt 1's pre-check sees plenty of budget (deadline 1000, now 0); the
    // post-failure check sees only 1ms left (deadline 1000, now 999) — under
    // MIN_RETRY_HEADROOM_MS, so the retryable error does NOT get a retry.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(999);
    const budget = { deadlineAt: 1000 };

    const result = runGitSpawn(["rev-parse", "HEAD"], "/tmp/repo", "readGitIdentity", "test", budget);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("a sequence of calls sharing one caller budget stops early once it is spent", () => {
    spawnSyncMock.mockReturnValue({ error: undefined, status: 0, stdout: "ok", stderr: "" });
    const budget = { deadlineAt: 100 };
    // First call's pre-check: deadline 100, now 0 -> 100ms left, proceeds and
    // succeeds. Second call (SAME budget object) pre-check: deadline 100, now
    // 150 -> already past the deadline -> stops before ever calling spawnSync.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(150);

    const first = runGitSpawn(["status", "--porcelain"], "/tmp/repo", "op1", "test", budget);
    const second = runGitSpawn(["diff", "HEAD"], "/tmp/repo", "op2", "test", budget);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.attempts).toBe(0);
    expect(second.error).toContain("budget exhausted");
    // The second call never even reached spawnSync.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });
});
