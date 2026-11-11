import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeDelegation,
  DelegationManager,
  failDelegation,
  STALE_DELIVERY_TURNS,
  type StoredDelegation,
} from "../delegations.js";

/**
 * Every path by which a delivered result reaches main must end in
 * acknowledgedVersion === resultVersion. Evidence: replay c2fda568be6b left 10
 * of 33 jobs delivered-but-unacked (failure notices, partial pages, plan-review
 * dossiers, deliveries made before a restart or behind errored turns), which
 * pinned ~830k tokens of working context.
 */
describe("host ACK covers every delivery path", () => {
  let home: string;
  let cwd: string;
  let dir: string;
  let manager: DelegationManager;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-autoack-"));
    cwd = path.join(home, "workspace");
    dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    vi.stubEnv("MUONROI_CLI_HOME", home);
    vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const jobFile = (id: string) => path.join(dir, `${id}.json`);
  const stored = (id: string): StoredDelegation => JSON.parse(fs.readFileSync(jobFile(id), "utf8"));
  const isAcked = (id: string) => {
    const record = stored(id);
    return !!record.resultVersion && record.acknowledgedVersion === record.resultVersion;
  };
  // Turn start times strictly after any delivery made by the test so far.
  let clock = 0;
  const turnStart = () => new Date(Date.now() + 60_000 + ++clock * 1000).toISOString();

  function seedRunning(id: string): void {
    const record: StoredDelegation = {
      id,
      agent: "general",
      description: "Fixture worker",
      prompt: "do it",
      cwd,
      model: "fixture",
      sandboxMode: "off",
      maxToolRounds: 2,
      maxTokens: 100,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, `${id}.md`),
      parentSessionId: "owner",
    };
    fs.writeFileSync(jobFile(id), JSON.stringify(record));
  }

  async function seedComplete(id: string, output: string): Promise<void> {
    seedRunning(id);
    await completeDelegation(jobFile(id), output);
  }

  async function seedFailed(id: string): Promise<void> {
    seedRunning(id);
    await failDelegation(jobFile(id), "ENOENT: spawn dotnet failed");
  }

  it("a failed job's notice is a whole delivery: ACKed after the turn that started with it", async () => {
    await seedFailed("failed-worker");
    const notices = await manager.consumeNotifications(() => undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("Background agent failed");
    expect(notices[0]!.message).toContain("ENOENT: spawn dotnet failed");
    expect(isAcked("failed-worker")).toBe(false);
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [])).toEqual(["failed-worker"]);
    expect(isAcked("failed-worker")).toBe(true);
  });

  it("a cancelled job's notice is a whole delivery too", async () => {
    seedRunning("cancelled-worker");
    await failDelegation(jobFile("cancelled-worker"), "Cancelled by user.", "", { cancelled: true });
    await manager.consumeNotifications(() => undefined);
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [])).toEqual(["cancelled-worker"]);
  });

  it("a wake-up turn that errored before the model ran leaves the notice pending until a later turn completes", async () => {
    await seedComplete("woken-worker", "short result");
    await manager.consumeNotifications(() => undefined);
    const watermark = manager.currentDeliverySeq();
    // The wake turn errored (preflight overflow / watchdog): appendCompletedTurn never ran, so
    // acknowledgeProcessed was never called and nothing is ACKed.
    expect(isAcked("woken-worker")).toBe(false);
    // A later turn that completes carries a watermark at or above the notice sequence.
    expect(await manager.acknowledgeProcessed(watermark, [])).toEqual(["woken-worker"]);
  });

  it("a result larger than the inline limit stays outstanding until completed turns have gone past it", async () => {
    vi.stubEnv("MUONROI_DELEGATION_INLINE_RESULT_CHARS", "256");
    await seedComplete("big-worker", `Verified. ${"x".repeat(2000)}`);
    const notices = await manager.consumeNotifications(() => undefined);
    expect(notices[0]!.message).toContain("first part inline below");
    // Not a whole delivery: the notice-seq path must not ACK it.
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [])).toEqual([]);
    for (let turn = 1; turn < STALE_DELIVERY_TURNS; turn++) {
      expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual([]);
      expect(isAcked("big-worker")).toBe(false);
    }
    expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual(["big-worker"]);
    expect(isAcked("big-worker")).toBe(true);
    // Nothing left to count.
    expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual([]);
  });

  it("a partial page read does not ACK; the guard does after enough completed turns", async () => {
    await seedComplete("paged-worker", `Verified. ${"y".repeat(3000)}`);
    const first = (await manager.readResult("paged-worker", true, { offset: 0, maxChars: 500 })).output!;
    expect(await manager.acknowledgeProcessed(0, [first])).toEqual([]);
    for (let turn = 1; turn < STALE_DELIVERY_TURNS; turn++) await manager.acknowledgeProcessed(0, [], turnStart());
    expect(isAcked("paged-worker")).toBe(false);
    expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual(["paged-worker"]);
  });

  it("counts a turn once even when it appends more than once", async () => {
    await seedComplete("once-worker", `Verified. ${"z".repeat(3000)}`);
    await manager.readResult("once-worker", true, { offset: 0, maxChars: 500 });
    const same = turnStart();
    for (let i = 0; i < 5; i++) await manager.acknowledgeProcessed(0, [], same);
    expect(stored("once-worker").deliveredTurnsSeen).toBe(1);
    expect(isAcked("once-worker")).toBe(false);
  });

  it("does not count a turn that started before the delivery", async () => {
    await seedComplete("late-worker", `Verified. ${"w".repeat(3000)}`);
    const early = new Date(Date.now() - 60_000).toISOString();
    await manager.acknowledgeProcessed(0, [], early); // hydrates candidates; nothing delivered yet
    await manager.readResult("late-worker", true, { offset: 0, maxChars: 500 });
    for (let i = 0; i < STALE_DELIVERY_TURNS + 2; i++)
      await manager.acknowledgeProcessed(0, [], new Date(Date.now() - 30_000 + i).toISOString());
    expect(stored("late-worker").deliveredTurnsSeen ?? 0).toBe(0);
    expect(isAcked("late-worker")).toBe(false);
  });

  it("a delivery from before a restart is still ACKed: the count lives on the job record", async () => {
    await seedComplete("restart-worker", `Verified. ${"r".repeat(3000)}`);
    await manager.readResult("restart-worker", true, { offset: 0, maxChars: 500 });
    await manager.acknowledgeProcessed(0, [], turnStart());
    expect(stored("restart-worker").deliveredTurnsSeen).toBe(1);

    const resumed = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    expect(await resumed.acknowledgeProcessed(0, [], turnStart())).toEqual([]);
    expect(await resumed.acknowledgeProcessed(0, [], turnStart())).toEqual(["restart-worker"]);
    expect(isAcked("restart-worker")).toBe(true);
  });

  it("never ACKs a running job, an undelivered job or a helper observation", async () => {
    seedRunning("running-worker");
    await seedComplete("undelivered-worker", "done");
    await seedComplete("helper-worker", "done");
    await manager.read("helper-worker", false);
    for (let i = 0; i < STALE_DELIVERY_TURNS + 1; i++)
      expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual([]);
    expect(stored("running-worker").acknowledgedVersion).toBeUndefined();
    expect(stored("undelivered-worker").acknowledgedVersion).toBeUndefined();
    expect(stored("helper-worker").acknowledgedVersion).toBeUndefined();
  });

  it("a re-delivered new version restarts the count", async () => {
    await seedComplete("redo-worker", `v1 ${"a".repeat(3000)}`);
    await manager.readResult("redo-worker", true, { offset: 0, maxChars: 500 });
    await manager.acknowledgeProcessed(0, [], turnStart());
    await manager.acknowledgeProcessed(0, [], turnStart());
    expect(stored("redo-worker").deliveredTurnsSeen).toBe(2);
    // The job runs again and finishes with a different result.
    const record = stored("redo-worker");
    record.status = "running";
    delete record.resultVersion;
    fs.writeFileSync(jobFile("redo-worker"), JSON.stringify(record));
    await completeDelegation(jobFile("redo-worker"), `v2 ${"b".repeat(3000)}`);
    await manager.readResult("redo-worker", true, { offset: 0, maxChars: 500 });
    expect(stored("redo-worker").deliveredTurnsSeen).toBe(0);
    expect(await manager.acknowledgeProcessed(0, [], turnStart())).toEqual([]);
    expect(isAcked("redo-worker")).toBe(false);
  });
});
