/**
 * Regression: resuming /ideal session 0a0d0430e149 (pid 31932) grew to 6 GB heap.
 * The TUI polls getBackgroundJobSnapshot() every 2s with no in-flight guard, and
 * one call blocks ~10.5s per job lock whose holder died (withFileLock timeout,
 * serialized in-process per path). Un-coalesced polls therefore piled up, each
 * retaining its parsed job records (measured: 75 calls in flight after 180s).
 *
 * Deterministic counters, not heap thresholds: while one read is pending, any
 * number of callers must trigger exactly one registry read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { logger } from "../../utils/logger.js";
import { DelegationManager } from "../delegations.js";
import { Agent } from "../orchestrator.js";

const MODEL = "deepseek-v4-flash";
const ENV_KEYS = ["HOME", "USERPROFILE", "MUONROI_CLI_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};
let tmpHome: string;

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-snapshot-flight-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MUONROI_CLI_HOME = path.join(tmpHome, ".muonroi-cli");
  closeDatabase();
  getDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("getBackgroundJobSnapshot coalesces concurrent polls", () => {
  it("reads the registry once while a read is pending, then again on the next poll", async () => {
    const agent = new Agent("sk-dummy", undefined, MODEL, undefined, { persistSession: false });
    const gate = deferred<never[]>();
    const list = vi.spyOn(DelegationManager.prototype, "list").mockImplementation(() => gate.promise);

    // 30 ticks of the 2s TUI poll arriving while the first read is still blocked.
    const polls = Array.from({ length: 30 }, () => agent.getBackgroundJobSnapshot());
    expect(list).toHaveBeenCalledTimes(1);

    gate.resolve([]);
    const snaps = await Promise.all(polls);
    expect(snaps.every((s) => s === snaps[0])).toBe(true);

    await agent.getBackgroundJobSnapshot();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh read after a failed one instead of caching the failure", async () => {
    const agent = new Agent("sk-dummy", undefined, MODEL, undefined, { persistSession: false });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const list = vi
      .spyOn(DelegationManager.prototype, "list")
      .mockRejectedValueOnce(new Error("withFileLock: timed out"))
      .mockResolvedValue([]);

    // list() failures are logged and swallowed inside the snapshot (existing behaviour).
    await agent.getBackgroundJobSnapshot();
    await agent.getBackgroundJobSnapshot();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("DelegationManager.pollApprovals survives a wedged job lock", () => {
  it("skips a job whose lock times out and still polls the others", async () => {
    const manager = new DelegationManager(
      () => tmpHome,
      () => "owner",
    );
    manager.setApprovalController(true);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const jobsDir = path.join(tmpHome, ".muonroi-cli", "delegations");
    // Two paths; the first one's lock is held by a holder that never releases.
    const a = path.join(jobsDir, "p", "wedged.json");
    const b = path.join(jobsDir, "p", "ok.json");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    for (const p of [a, b]) fs.writeFileSync(p, JSON.stringify({ id: path.basename(p), parentSessionId: "owner" }));
    fs.writeFileSync(`${a}.lock`, "999999");
    vi.spyOn(manager as unknown as { jobPaths(): Promise<string[]> }, "jobPaths").mockResolvedValue([a, b]);

    // Bound the wait: the wedged lock would otherwise cost the full 10s timeout.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const run = manager.pollApprovals();
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(run).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect(warn).toHaveBeenCalledWith(
      "orchestrator",
      "Worker approval poll skipped a job",
      expect.objectContaining({ jobPath: a }),
    );
  });
});
