import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeDelegation, DelegationManager, failDelegation, type StoredDelegation } from "../delegations.js";

describe("durable delegation delivery", () => {
  let home: string;
  let cwd: string;
  let jobPath: string;
  let outputPath: string;
  let manager: DelegationManager;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-delivery-"));
    cwd = path.join(home, "workspace");
    const scope = `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`;
    const dir = path.join(home, "delegations", scope);
    fs.mkdirSync(dir, { recursive: true });
    jobPath = path.join(dir, "owned-worker.json");
    outputPath = path.join(dir, "owned-worker.md");
    const record: StoredDelegation = {
      id: "owned-worker",
      agent: "explore",
      description: "Scoped verification",
      prompt: "Verify assigned files",
      cwd,
      model: "fixture",
      sandboxMode: "off",
      maxToolRounds: 2,
      maxTokens: 100,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath,
      parentSessionId: "owner",
    };
    fs.writeFileSync(jobPath, JSON.stringify(record));
    vi.stubEnv("MUONROI_CLI_HOME", home);
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    await completeDelegation(
      jobPath,
      "Verified fixture.ts:12; command: fixture-test; exit code: 0. Not checked: integration.",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stored = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

  it("a full read is delivered but not ACKed until a model turn has processed it", async () => {
    const output = await manager.read("owned-worker");
    const record = stored(jobPath);
    expect(output).toContain("Execution: complete");
    expect(output).toContain("Delivery: delivered");
    expect(output).toContain("Acknowledgement: pending");
    expect(output).not.toContain("delegation_ack(");
    expect(record.acknowledgedVersion).toBeUndefined();
    expect(record.deliveredVersion).toBe(record.resultVersion);

    // A completed turn whose model never saw that tool result does not ACK it.
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [])).toEqual([]);
    expect(stored(jobPath).acknowledgedVersion).toBeUndefined();
    // Seen (the tool-result text followed by a later assistant step) → host ACK.
    expect(await manager.acknowledgeProcessed(0, [output])).toEqual(["owned-worker"]);
    expect(stored(jobPath).acknowledgedVersion).toBe(record.resultVersion);
    // One ACK per delivery: nothing left to process.
    expect(await manager.acknowledgeProcessed(0, [output])).toEqual([]);
  });

  it("a partial page is not a processed result; the page reaching the end is", async () => {
    const first = (await manager.readResult("owned-worker", true, { offset: 0, maxChars: 256 })).output!;
    const record = stored(jobPath);
    const total = fs.readFileSync(outputPath, "utf8").length;
    if (total > 256) {
      expect(await manager.acknowledgeProcessed(0, [first])).toEqual([]);
      const last = (await manager.readResult("owned-worker", true, { offset: 256, maxChars: 24_000 })).output!;
      expect(await manager.acknowledgeProcessed(0, [last])).toEqual(["owned-worker"]);
    } else {
      expect(await manager.acknowledgeProcessed(0, [first])).toEqual(["owned-worker"]);
    }
    expect(stored(jobPath).acknowledgedVersion).toBe(record.resultVersion);
  });

  it("a fully inline completion notice is ACKed after the next turn that started with it", async () => {
    const notices = await manager.consumeNotifications(() => undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("Result (complete, inline below; no delegation_read needed):");
    expect(notices[0]!.message).not.toContain("delegation_ack");
    const watermark = manager.currentDeliverySeq();
    // A turn that started before the notice was consumed did not see it.
    expect(await manager.acknowledgeProcessed(watermark - 1, [])).toEqual([]);
    expect(await manager.acknowledgeProcessed(watermark, [])).toEqual(["owned-worker"]);
    expect(stored(jobPath).acknowledgedVersion).toBe(stored(jobPath).resultVersion);
  });

  it("refuses to return content for a running job", async () => {
    const running = stored(jobPath);
    running.status = "running";
    running.pid = process.pid;
    fs.writeFileSync(jobPath, JSON.stringify(running));
    const result = await manager.readResult("owned-worker");
    expect(result.output).toMatch(/^delegation_running: jobId=owned-worker is still running/);
    expect(result.output).toContain("you will be woken with its result on completion");
    expect(result.output).not.toContain("Verified fixture.ts:12");
  });

  it("makes helper observation distinct from owner delivery and ACK", async () => {
    const output = await manager.read("owned-worker", false);
    expect(output).toContain("Delivery: pending");
    expect(output).toContain("Helper: forward this jobId/resultVersion to main");
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [output])).toEqual([]);
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
    expect(stored(jobPath).acknowledgedVersion).toBeUndefined();
  });

  it("does not request another ACK for an already acknowledged version", async () => {
    await manager.read("owned-worker");
    const version = stored(jobPath).resultVersion;
    await manager.acknowledge("owned-worker", version);
    const output = await manager.read("owned-worker");
    expect(output).toContain("Acknowledgement: acknowledged");
    expect(output).not.toContain("delegation_ack(");
    expect(stored(jobPath).acknowledgedVersion).toBe(version);
  });

  it("returns a structured failure when a completed artifact is missing", async () => {
    fs.unlinkSync(outputPath);
    expect((await manager.readResult("owned-worker")).success).toBe(false);
    expect((await manager.readResult("missing-worker")).success).toBe(false);
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
  });

  it("leaves notification pending if durable main handoff fails, then retries after restart", async () => {
    const persist = vi.fn(() => {
      throw new Error("fixture transcript unavailable");
    });
    expect(await manager.consumeNotifications(persist)).toEqual([]);
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
    const resumed = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    const delivered: string[] = [];
    const notices = await resumed.consumeNotifications((notice) => {
      delivered.push(notice.message);
    });
    expect(notices).toHaveLength(1);
    expect(delivered).toEqual([notices[0].message]);
    expect(await resumed.consumeNotifications()).toEqual([]);
  });

  it("keeps other completed notices deliverable when one owner's transcript write fails", async () => {
    const second = stored(jobPath);
    second.id = "second-worker";
    const secondPath = path.join(path.dirname(jobPath), "second-worker.json");
    fs.writeFileSync(secondPath, JSON.stringify(second));
    const notices = await manager.consumeNotifications((notice) => {
      if (notice.id === "owned-worker") throw new Error("fixture single-notice failure");
    });
    expect(notices.map((n) => n.id)).toEqual(["second-worker"]);
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
    expect(stored(secondPath).deliveredVersion).toBe(second.resultVersion);
  });

  it("does not auto-wake main for a result already delivered by read, including after restart", async () => {
    expect(await manager.read("owned-worker")).toContain("fixture.ts:12");
    const resumed = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    expect(await resumed.consumeNotifications()).toEqual([]);
    expect(stored(jobPath).deliveredVersion).toBe(stored(jobPath).resultVersion);
    expect(stored(jobPath).acknowledgedVersion).toBeUndefined();
  });

  it("notifies once with an immutable version and a readable durable result", async () => {
    const notices = await manager.consumeNotifications();
    expect(notices).toHaveLength(1);
    const version = stored(jobPath).resultVersion;
    expect(version).toBeTruthy();
    expect(notices[0].message).toContain(version);
    expect(notices[0].message).toContain(outputPath);
    expect(await manager.read("owned-worker")).toContain(version);
    expect(await manager.consumeNotifications()).toEqual([]);
  });

  it("does not let a helper read consume the owner's completion before handoff", async () => {
    expect(await manager.read("owned-worker", false)).toContain("fixture.ts:12");
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
    expect(await manager.consumeNotifications()).toHaveLength(1);
  });

  it("acknowledges only the delivered result version and persists it across restart", async () => {
    await manager.read("owned-worker");
    const version = stored(jobPath).resultVersion;
    expect((await manager.acknowledge("owned-worker", "stale-version")).success).toBe(false);
    expect((await manager.acknowledge("owned-worker", version)).success).toBe(true);
    const resumed = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    expect((await resumed.acknowledge("owned-worker", version)).success).toBe(true);
    expect(stored(jobPath).acknowledgedVersion).toBe(version);
    expect(await resumed.consumeNotifications()).toEqual([]);
  });

  it("does not announce completion if the saved output cannot be read", async () => {
    fs.unlinkSync(outputPath);
    expect(await manager.consumeNotifications()).toEqual([]);
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
  });

  it("does not deliver a changed artifact under the original version", async () => {
    fs.writeFileSync(outputPath, "replacement content");
    expect(await manager.consumeNotifications()).toEqual([]);
    expect(await manager.read("owned-worker")).not.toContain("replacement content");
    expect(stored(jobPath).deliveredVersion).toBeUndefined();
  });

  it("does not acknowledge another owner's result", async () => {
    const foreign = new DelegationManager(
      () => cwd,
      () => "other-owner",
    );
    expect((await foreign.acknowledge("owned-worker", stored(jobPath).resultVersion)).success).toBe(false);
    expect(stored(jobPath).acknowledgedVersion).toBeUndefined();
  });

  it("keeps cancelled execution distinct from failure and delivery", async () => {
    const record = stored(jobPath);
    record.status = "running";
    delete record.resultVersion;
    fs.writeFileSync(jobPath, JSON.stringify(record));
    await failDelegation(jobPath, "Cancelled by user.", "", { cancelled: true });
    expect(stored(jobPath).status).toBe("cancelled");
    const notices = await manager.consumeNotifications();
    expect(notices[0].message).toContain("Background agent cancelled");
    expect((await manager.list())[0]).toMatchObject({ status: "cancelled", deliveryStatus: "delivered" });
    expect(stored(jobPath).acknowledgedVersion).toBeUndefined();
  });
});
