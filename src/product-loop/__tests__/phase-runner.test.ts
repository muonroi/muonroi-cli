import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendCustomerDecision,
  clearAwaitingCustomerReview,
  clearRetroPending,
  collectStuckPhases,
  markAwaitingCustomerReview,
  markPhaseStatus,
  markRetroPending,
  readLastActivity,
  readPhaseStatus,
  updateLastActivity,
} from "../phase-runner.js";

describe("phase-runner markers (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `runner-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("markPhaseStatus writes and reads back", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "in-progress");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("in-progress");
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("done");
  });

  it("awaiting-customer-review marker round-trip", async () => {
    await markAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeDefined();
    await clearAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeUndefined();
  });

  it("retro-pending marker round-trip", async () => {
    await markRetroPending(flowDir, runId, "phase-1", 1);
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.get("retro-pending:phase-1:sprint-1")).toBeDefined();
    await clearRetroPending(flowDir, runId, "phase-1", 1);
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2?.sections.get("retro-pending:phase-1:sprint-1")).toBeUndefined();
  });

  it("appendCustomerDecision uses monotonic seq", async () => {
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1",
      sprintN: 1,
      verdict: "accept",
    });
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1",
      sprintN: 2,
      verdict: "reject",
      feedback: "needs work",
    });
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const raw = map?.sections.get("Customer Decisions");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].seq).toBe(1);
    expect(parsed.items[1].seq).toBe(2);
    expect(parsed.items[1].feedback).toBe("needs work");
  });

  it("updateLastActivity + readLastActivity round-trip", async () => {
    await updateLastActivity(flowDir, runId);
    const got = await readLastActivity(flowDir, runId);
    expect(got).toBeTruthy();
    expect(new Date(got!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("collectStuckPhases returns blocked + pending IDs", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    await markPhaseStatus(flowDir, runId, "phase-2", "blocked");
    await markPhaseStatus(flowDir, runId, "phase-3", "pending");
    const stuck = await collectStuckPhases(flowDir, runId);
    expect(stuck.sort()).toEqual(["phase-2", "phase-3"]);
  });
});
