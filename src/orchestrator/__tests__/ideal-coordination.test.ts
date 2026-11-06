/**
 * Local /ideal status and /ideal abort in the orchestrator role. Before this,
 * runProductLoopV1 forwarded both to processMessage as a "coordinate the user's
 * /ideal status request" prompt — a model call to read host state, and an
 * abort that could only ask the model to stop its workers.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import * as settings from "../../utils/settings.js";
import {
  formatIdealAbort,
  formatIdealStatus,
  type IdealCoordinationRun,
  type IdealJob,
  jobsOfIdealRun,
} from "../ideal-coordination.js";
import { Agent } from "../orchestrator.js";

const RUN: IdealCoordinationRun = { goal: "Build the parser", startedAt: "2026-11-06T10:00:00.000Z" };
const job = (id: string, status: IdealJob["status"], startedAt: string): IdealJob => ({
  id,
  agent: "general",
  description: `work ${id}`,
  status,
  startedAt,
});
const NO_FLOW = { phase: null, depth: null, planVerified: false, exists: false };

describe("ideal-coordination formatting", () => {
  it("attributes only jobs started at or after /ideal start", () => {
    const ledger = [
      job("old-job-one", "running", "2026-11-06T09:59:59.999Z"),
      job("same-time-job", "complete", "2026-11-06T10:00:00.000Z"),
      job("later-job-two", "running", "2026-11-06T10:05:00.000Z"),
    ];
    expect(jobsOfIdealRun(RUN, ledger).map((j) => j.id)).toEqual(["same-time-job", "later-job-two"]);
  });

  it("status names the goal, flow state and every worker with its status", () => {
    const text = formatIdealStatus({
      run: RUN,
      jobs: [job("a-b-c", "running", RUN.startedAt), job("d-e-f", "complete", RUN.startedAt)],
      flow: { phase: "execute", depth: "heavy", planVerified: true, exists: true },
      now: new Date("2026-11-06T10:01:05.000Z"),
    });
    expect(text).toContain("Goal: Build the parser");
    expect(text).toContain("1m 5s ago");
    expect(text).toContain("phase=execute  depth=heavy  plan verified=yes");
    expect(text).toContain("Workers (1 running, 1 finished):");
    expect(text).toMatch(/a-b-c\s+running/);
    expect(text).toMatch(/d-e-f\s+complete/);
    expect(text).toContain("/ideal abort");
  });

  it("status without a run says so instead of inventing one", () => {
    const text = formatIdealStatus({ run: null, jobs: [], flow: NO_FLOW, now: new Date() });
    expect(text).toContain("No /ideal run has been started in this session.");
    expect(text).toContain("no .planning/STATE.md");
    expect(text).not.toContain("Workers");
  });

  it("abort lists what it stopped, what it could not, and what had finished", () => {
    const text = formatIdealAbort({
      run: RUN,
      outcomes: [
        { id: "a-b-c", success: true, output: "killed" },
        { id: "x-y-z", success: false, output: "access denied" },
      ],
      finished: 2,
    });
    expect(text).toContain("Stopped 1 worker(s): a-b-c");
    expect(text).toContain("Could not stop x-y-z: access denied");
    expect(text).toContain("2 worker(s) had already finished");
    expect(formatIdealAbort({ run: null, outcomes: [], finished: 0 })).toContain("nothing to stop");
  });
});

describe("Agent.runProductLoopV1 — status/abort never call the model", () => {
  beforeAll(async () => {
    await loadCatalog();
    registerTestProviderFactories();
  });
  afterEach(() => vi.restoreAllMocks());

  async function drain(gen: AsyncGenerator<{ type: string; content?: string }>) {
    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
  }

  it("start records the run; status and abort answer from host state; abort kills only running run jobs", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const internal = root as any;
    const model = vi.spyOn(root, "processMessage").mockImplementation(async function* () {
      yield { type: "content", content: "Main coordinates bounded workers" };
    });
    try {
      await drain(root.runProductLoopV1({ subcommand: "start", idea: "Ship it", flags: { doneThreshold: 90 } }));
      expect(model).toHaveBeenCalledTimes(1);
      model.mockClear();

      const before = new Date(Date.now() - 60_000).toISOString();
      const after = new Date(Date.now() + 1_000).toISOString();
      vi.spyOn(internal.delegations, "ledgerSnapshot").mockResolvedValue([
        { ...job("pre-run-job", "running", before), acknowledged: false },
        { ...job("run-worker-a", "running", after), acknowledged: false },
        { ...job("run-worker-b", "complete", after), acknowledged: false },
      ]);
      const kill = vi.spyOn(internal.delegations, "kill").mockResolvedValue({ success: true, output: "killed" });

      const status = await drain(root.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }));
      expect(model).not.toHaveBeenCalled();
      expect(status.map((c) => c.type)).toEqual(["content", "done"]);
      expect(status[0]!.content).toContain("Goal: Ship it");
      expect(status[0]!.content).toContain("run-worker-a");
      expect(status[0]!.content).not.toContain("pre-run-job");

      const abort = await drain(root.runProductLoopV1({ subcommand: "abort", flags: { doneThreshold: 90 } }));
      expect(model).not.toHaveBeenCalled();
      expect(kill.mock.calls.map((c) => c[0])).toEqual(["run-worker-a"]);
      expect(abort[0]!.content).toContain("Stopped 1 worker(s): run-worker-a");

      const afterAbort = await drain(root.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }));
      expect(afterAbort[0]!.content).toContain("No /ideal run has been started in this session.");

      // The aborted worker's cancellation must not wake the model ("continue the
      // task") — any other job's notice still does, and only once.
      vi.spyOn(internal.delegations, "consumeNotifications").mockResolvedValue([
        { id: "run-worker-a", message: "[jobId=run-worker-a status=cancelled] Cancelled by user." },
        { id: "unrelated-job", message: "[jobId=unrelated-job status=complete] done" },
      ]);
      const surfaced = await root.consumeBackgroundNotifications();
      expect(surfaced.some((m) => m.includes("run-worker-a"))).toBe(false);
      expect(surfaced.some((m) => m.includes("unrelated-job"))).toBe(true);
      const again = await root.consumeBackgroundNotifications();
      expect(again.some((m) => m.includes("run-worker-a"))).toBe(true); // one-shot suppression
    } finally {
      await root.cleanup();
    }
  });
});
