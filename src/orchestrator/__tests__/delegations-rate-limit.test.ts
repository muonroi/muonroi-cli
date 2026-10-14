/**
 * A background delegation that dies rate-limited must tell the MAIN agent what
 * happened and what to do — the bare provider text ("Rate limit reached, please
 * try again later.") invited an immediate re-launch of all 17 agents, the one
 * response that makes a shared account budget worse.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderRateLimitError } from "../../providers/rate-limit-backoff.js";
import {
  DelegationManager,
  delegationFailureKind,
  failDelegation,
  loadDelegation,
  noteDelegationProgress,
  rateLimitedDelegationError,
  type StoredDelegation,
} from "../delegations.js";

describe("delegationFailureKind", () => {
  it("recognises a rate limit from a thrown error or flattened failure text", () => {
    expect(delegationFailureKind(Object.assign(new Error("Rate limit reached"), { statusCode: 429 }))).toBe(
      "rate-limited",
    );
    expect(delegationFailureKind(new ProviderRateLimitError({ attempts: 7, waitedMs: 1, cause: "x" }))).toBe(
      "rate-limited",
    );
    expect(delegationFailureKind("Task failed: HTTP 429: Rate limit reached, please try again later.")).toBe(
      "rate-limited",
    );
  });

  it("leaves other failures — including out-of-balance 429s — unclassified", () => {
    expect(delegationFailureKind("Task failed: HTTP 429: Insufficient balance. Please recharge.")).toBeUndefined();
    expect(delegationFailureKind(new Error("ENOENT"))).toBeUndefined();
    expect(delegationFailureKind("Task failed: HTTP 401: bad key")).toBeUndefined();
    // Partial research ABOUT rate limits, then an unrelated failure: judged on the failure only.
    expect(
      delegationFailureKind("The API enforces a rate limit of 100 RPM.\n\nTask failed: HTTP 500: upstream error"),
    ).toBeUndefined();
  });

  it("wraps bare provider text with guidance, but does not double-wrap the gate's own message", () => {
    const wrapped = rateLimitedDelegationError("Rate limit reached, please try again later.");
    expect(wrapped).toContain("shared by the main agent and every background delegation");
    expect(wrapped).toContain("launch fewer agents in parallel");
    expect(wrapped).toContain("Provider said: Rate limit reached, please try again later.");
    const gate = new ProviderRateLimitError({ provider: "acme", attempts: 7, waitedMs: 230_000, cause: "x" }).message;
    expect(rateLimitedDelegationError(gate)).toBe(gate);
  });
});

describe("rate-limited delegation records", () => {
  let tmpDir: string;
  let jobPath: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-delegation-rl-"));
    jobPath = path.join(tmpDir, "calm-teal-owl.json");
    outputPath = path.join(tmpDir, "calm-teal-owl.md");
    const record = {
      id: "calm-teal-owl",
      agent: "explore",
      description: "Probe",
      prompt: "ALIVE",
      cwd: tmpDir,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath,
    } as unknown as StoredDelegation;
    fs.writeFileSync(jobPath, JSON.stringify(record), "utf8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(`[delegations-rate-limit.test] cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("shows a backing-off worker's retry notice while it runs", async () => {
    await noteDelegationProgress(jobPath, "[retry] rate-limited by acme (429) — waiting 16s before attempt 3/8");
    expect((await loadDelegation(jobPath)).summary).toContain("rate-limited by acme (429)");
  });

  it("records failureKind and an actionable error the main agent will read", async () => {
    await failDelegation(jobPath, "Rate limit reached, please try again later.", "", { failureKind: "rate-limited" });
    const record = await loadDelegation(jobPath);
    expect(record.status).toBe("error");
    expect(record.failureKind).toBe("rate-limited");
    expect(record.error).toContain("Do not re-launch it immediately");
    expect(fs.readFileSync(outputPath, "utf8")).toContain("launch fewer agents in parallel");
    // A progress note after the end never overwrites the final summary.
    const summary = record.summary;
    await noteDelegationProgress(jobPath, "[retry] late");
    expect((await loadDelegation(jobPath)).summary).toBe(summary);
  });

  it("exposes failureKind on the listed run (the hook for the parent)", async () => {
    // List through the manager against a fake home so ensureDelegationsDir resolves into tmp.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-delegation-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const mgr = new DelegationManager(() => tmpDir);
      const runs0 = await mgr.list();
      expect(runs0).toEqual([]);
      // list() created this project's delegation dir under the fake home.
      const root = path.join(home, ".muonroi-cli", "delegations");
      const dir = path.join(root, fs.readdirSync(root)[0]!);
      const listedJob = path.join(dir, "calm-teal-owl.json");
      fs.copyFileSync(jobPath, listedJob);
      await failDelegation(listedJob, "Task failed: HTTP 429: Rate limit reached", "", {
        failureKind: "rate-limited",
      });
      const [run] = await mgr.list();
      expect(run).toMatchObject({ id: "calm-teal-owl", status: "error", failureKind: "rate-limited" });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
