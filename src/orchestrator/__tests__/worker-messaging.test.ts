import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "../../tools/file.js";
import { WorkerWriteScope } from "../../tools/worker-write-scope.js";
import {
  appendWorkerMessage,
  injectOwnerMessages,
  MESSAGE_LIMITS,
  pendingQuestion,
  waitForWorkerReply,
} from "../delegation-mailbox.js";
import { DelegationManager, failDelegation, type StoredDelegation } from "../delegations.js";
import { isInteractivePaused } from "../interactive-pause.js";
import { runScopedDelegationWrite } from "../worker-write-authorization.js";

let home: string, cwd: string, file: string, manager: DelegationManager;
const read = (): StoredDelegation => JSON.parse(fs.readFileSync(file, "utf8"));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-messages-"));
  cwd = path.join(home, "workspace");
  fs.mkdirSync(cwd);
  vi.stubEnv("MUONROI_CLI_HOME", home);
  const dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "owned-worker.json");
  const record: StoredDelegation = {
    id: "owned-worker",
    agent: "general",
    kind: "task",
    description: "Scoped work",
    prompt: "Assigned scope",
    cwd,
    model: "fixture-model",
    modelId: "fixture-model",
    providerId: "fixture-provider",
    reasoningEffort: "low",
    allowedMcpTools: [],
    executionRole: "worker",
    permissionMode: "safe",
    sandboxMode: "off",
    maxToolRounds: 3,
    maxTokens: 100,
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    outputPath: path.join(dir, "owned-worker.md"),
    parentSessionId: "owner",
  };
  record.messagingProtocol = 1;
  fs.writeFileSync(file, JSON.stringify(record));
  manager = new DelegationManager(
    () => cwd,
    () => "owner",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});

describe("bounded durable owner/worker messaging", () => {
  it("includes scope decision bytes in the bounded mailbox and leaves rejected decisions unapplied", async () => {
    const rec = read();
    rec.writeScope = [];
    rec.writeScopeVersion = 1;
    rec.writeScopeBinding = new WorkerWriteScope(cwd, []).binding;
    rec.mailbox = { messages: [], nextSequence: 1, totalBytes: MESSAGE_LIMITS.totalBytes - 8 };
    fs.writeFileSync(file, JSON.stringify(rec));
    expect(
      (await manager.sendMessage("owned-worker", "ok", undefined, "too-large-scope", ["A-long-directory/"])).success,
    ).toBe(false);
    expect(read().writeScope).toEqual([]);
    expect(read().writeScopeVersion).toBe(1);
    expect(read().mailbox!.messages).toHaveLength(0);
  });
  it("serializes scope decisions with an in-flight write and rejects subsequent writes after the decision", async () => {
    const rec = read();
    rec.writeScope = ["A/"];
    rec.writeScopeVersion = 1;
    rec.writeScopeBinding = new WorkerWriteScope(cwd, rec.writeScope).binding;
    fs.writeFileSync(file, JSON.stringify(rec));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const writing = runScopedDelegationWrite(file, async (scope) => {
      entered();
      await held;
      return writeFile("A/in-flight.txt", "before decision", cwd, undefined, scope);
    });
    await started;
    const decision = manager.sendMessage("owned-worker", "Revoke writes", undefined, "serialized-revoke", []);
    release();
    expect((await writing).success).toBe(true);
    expect((await decision).success).toBe(true);
    expect(
      (await runScopedDelegationWrite(file, (scope) => writeFile("A/after.txt", "no", cwd, undefined, scope))).success,
    ).toBe(false);
    expect(fs.existsSync(path.join(cwd, "A/in-flight.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "A/after.txt"))).toBe(false);
  });
  it("atomically narrows/widens live write scope with owner messages and an exact correlated decision", async () => {
    const record = read();
    record.writeScope = ["A/", "B/"];
    record.writeScopeVersion = 1;
    record.writeScopeBinding = new WorkerWriteScope(cwd, record.writeScope).binding;
    fs.writeFileSync(file, JSON.stringify(record));
    const apply = (name: string) =>
      runScopedDelegationWrite(file, (scope) => writeFile(name, "evidence", cwd, undefined, scope));
    expect((await apply("A/first.txt")).success).toBe(true);
    const revoked = await manager.sendMessage("owned-worker", "Pause all writes", undefined, "revoke", []);
    expect(revoked.success).toBe(true);
    expect(revoked.output).toContain("writeScopeVersion=2");
    expect((await apply("A/forbidden.txt")).success).toBe(false);
    const q = await appendWorkerMessage(file, "question", "May I repair C?", "scope-question", 1000);
    expect((await manager.sendMessage("owned-worker", "Only C is approved", q.id, "approve-c", ["C/"])).success).toBe(
      true,
    );
    const answer = await waitForWorkerReply(file, q.id);
    expect(answer.output).toContain('writeScope=["C/"]');
    expect((await apply("C/fixed.txt")).success).toBe(true);
    expect((await apply("B/forbidden.txt")).success).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "A/first.txt"), "utf8")).toBe("evidence");
    expect(fs.existsSync(path.join(cwd, "A/forbidden.txt"))).toBe(false);
    const before = read();
    expect(before.writeScopeVersion).toBe(3);
    // Re-delivery of an old decision must not restore its earlier scope.
    expect((await manager.sendMessage("owned-worker", "Pause all writes", undefined, "revoke", [])).success).toBe(true);
    expect(read().writeScopeVersion).toBe(3);
    expect(read().writeScope).toEqual(["C/"]);
    expect((await manager.sendMessage("owned-worker", "Changed", undefined, "revoke", ["A/"])).success).toBe(false);
    expect(
      (await manager.sendMessage("owned-worker", "Bad correlation", "not-a-question", "bad-scope", ["A/"])).success,
    ).toBe(false);
    expect(
      (await manager.sendMessage("owned-worker", "Outside workspace", undefined, "escape", ["../escape/"])).success,
    ).toBe(false);
    expect(read().writeScope).toEqual(["C/"]);
    const injected = JSON.stringify(await injectOwnerMessages(file, [{ role: "user", content: "Task A" }]));
    expect(injected).toContain("Host scope decision");
    expect(injected).toContain("writeScopeVersion=3");
  });
  it("does not treat a prose instruction as permission or retrofit containment onto an unscoped job", async () => {
    expect((await manager.sendMessage("owned-worker", "You may edit anywhere", undefined, "prose")).success).toBe(true);
    expect(read().writeScope).toBeUndefined();
    expect((await manager.sendMessage("owned-worker", "Narrow now", undefined, "unsupported", [])).success).toBe(false);
    const rec = read();
    rec.writeScope = [];
    rec.writeScopeVersion = 1;
    rec.writeScopeBinding = new WorkerWriteScope(cwd, []).binding;
    fs.writeFileSync(file, JSON.stringify(rec));
    expect(
      (await manager.sendMessage("owned-worker", "Edit outside your list", undefined, "still-prose")).success,
    ).toBe(true);
    expect(
      (await runScopedDelegationWrite(file, (scope) => writeFile("outside.txt", "no", cwd, undefined, scope))).success,
    ).toBe(false);
    expect(
      (
        await new DelegationManager(
          () => cwd,
          () => "foreign",
        ).sendMessage("owned-worker", "Expand", undefined, "foreign-scope", ["A/"])
      ).success,
    ).toBe(false);
    expect(read().writeScope).toEqual([]);
  });
  it.each(["", " \t\n"])("queues proactive instructions when optional replyTo is blank: %j", async (replyTo) => {
    const before = read();
    const result = await manager.sendMessage(
      "owned-worker",
      "Use the authoritative three-segment JWT pattern",
      replyTo,
      "owner-correction",
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("queued=true");
    const sent = read().mailbox!.messages[0]!;
    expect(sent.kind).toBe("instruction");
    expect(sent.replyTo).toBeUndefined();
    expect(
      JSON.stringify(await injectOwnerMessages(file, [{ role: "user", content: "Original corpus task" }])),
    ).toContain("authoritative three-segment JWT");
    const after = read();
    for (const key of [
      "model",
      "modelId",
      "providerId",
      "allowedMcpTools",
      "permissionMode",
      "prompt",
      "executionRole",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(
      (
        await manager.sendMessage(
          "owned-worker",
          "Use the authoritative three-segment JWT pattern",
          undefined,
          "owner-correction",
        )
      ).output,
    ).toBe(result.output);
  });
  it("does not let an empty-correlation instruction answer or renew a pending question", async () => {
    const question = await appendWorkerMessage(file, "question", "Which fixture?", "worker-question", 1000);
    const sent = await manager.sendMessage(
      "owned-worker",
      "Also inspect the negative fixture",
      "",
      "owner-instruction",
    );
    expect(sent.success).toBe(true);
    expect(sent.output).toContain("kind=instruction");
    const pending = pendingQuestion(read());
    expect(pending?.id).toBe(question.id);
    expect(pending?.deadlineAt).toBe(question.deadlineAt);
    expect(read().mailbox!.messages.some((m) => m.kind === "reply")).toBe(false);
  });
  it("queues owner instructions promptly and injects them at the next safe model step", async () => {
    const before = read();
    const result = await manager.sendMessage("owned-worker", "Use the supplied fixture", undefined, "owner-call");
    expect(result.success).toBe(true);
    expect(result.output).toContain("status=running");
    const initial = [{ role: "user" as const, content: "Original task" }];
    const injected = await injectOwnerMessages(file, initial);
    expect(JSON.stringify(injected)).toContain("Use the supplied fixture");
    expect(JSON.stringify(injected)).toContain("owner-message:");
    expect(await injectOwnerMessages(file, injected)).toEqual(injected);
    expect(JSON.stringify(await injectOwnerMessages(file, initial))).toContain("Use the supplied fixture");
    const after = read();
    for (const key of [
      "model",
      "modelId",
      "providerId",
      "reasoningEffort",
      "allowedMcpTools",
      "executionRole",
      "permissionMode",
      "maxToolRounds",
      "maxTokens",
      "prompt",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.deliveredVersion).toBeUndefined();
    expect(after.acknowledgedVersion).toBeUndefined();
    expect(after.acceptance).toBeUndefined();
  });
  it("coalesces worker progress into one durable owner notice without terminal claims", async () => {
    const first = await appendWorkerMessage(file, "progress", "Read source", "worker-1");
    const second = await appendWorkerMessage(file, "progress", "Ran fixture", "worker-2");
    const persist = vi.fn();
    const notices = await manager.consumeNotifications(persist);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain(first.id);
    expect(notices[0]!.message).toContain(second.id);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(read().status).toBe("running");
    expect(read().notifiedAt).toBeUndefined();
    expect(read().deliveredVersion).toBeUndefined();
    expect(
      await new DelegationManager(
        () => cwd,
        () => "owner",
      ).consumeNotifications(persist),
    ).toEqual([]);
  });
  it("persists owner transcript before claiming message delivery and retries after persistence failure", async () => {
    const message = await appendWorkerMessage(file, "progress", "Evidence ready", "worker-progress");
    expect(
      await manager.consumeNotifications(() => {
        throw Error("transcript unavailable");
      }),
    ).toEqual([]);
    expect(read().mailbox!.messages[0]!.ownerDeliveredAt).toBeUndefined();
    expect(
      await manager.consumeNotifications((notice) => {
        expect(notice.message).toContain(message.id);
        expect(read().mailbox!.messages[0]!.ownerDeliveredAt).toBeUndefined();
      }),
    ).toHaveLength(1);
    expect(read().mailbox!.messages[0]!.ownerDeliveredAt).toBeTruthy();
  });
  it("never claims worker message delivery without a durable persistence callback", async () => {
    await appendWorkerMessage(file, "progress", "Pending owner persistence", "worker-progress");
    expect(await manager.consumeNotifications()).toEqual([]);
    expect(read().mailbox!.messages[0]!.ownerDeliveredAt).toBeUndefined();
  });
  it("yields an interim headless question and continues after the exact correlated owner reply", async () => {
    const question = await appendWorkerMessage(file, "question", "Which fixture?", "worker-question", 1000);
    const interim = await manager.waitResult("owned-worker");
    expect(interim.success).toBe(true);
    expect(interim.output).toContain("status=running");
    expect(interim.output).toContain(`messageId=${question.id}`);
    const waiting = waitForWorkerReply(file, question.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(isInteractivePaused()).toBe(true);
    expect((await manager.sendMessage("owned-worker", "fixture-a", question.id, "owner-reply")).success).toBe(true);
    const reply = await waiting;
    expect(reply.success).toBe(true);
    expect(reply.output).toContain("fixture-a");
    expect(reply.output).toContain(`replyTo=${question.id}`);
    expect(isInteractivePaused()).toBe(false);
    expect(read().status).toBe("running");
  });
  it("uses actual toolCallId for durable idempotency, and rejects changed reuse", async () => {
    const first = await appendWorkerMessage(file, "question", "Question?", "actual-sdk-call", 1000);
    expect((await appendWorkerMessage(file, "question", "Question?", "actual-sdk-call", 1000)).id).toBe(first.id);
    await expect(appendWorkerMessage(file, "question", "Changed", "actual-sdk-call", 1000)).rejects.toThrow(
      "idempotency",
    );
    const reply = await manager.sendMessage("owned-worker", "Answer", first.id, "actual-owner-call");
    expect(reply.success).toBe(true);
    expect((await manager.sendMessage("owned-worker", "Answer", first.id, "actual-owner-call")).output).toBe(
      reply.output,
    );
    expect((await manager.sendMessage("owned-worker", "Changed", first.id, "actual-owner-call")).success).toBe(false);
    expect((await manager.sendMessage("owned-worker", "Conflicting answer", first.id, "different-call")).success).toBe(
      false,
    );
    expect(read().mailbox!.messages).toHaveLength(2);
  });
  it.each([
    "foreign",
    "no-owner",
    "legacy",
    "terminal",
    "stale",
    "path",
    "missing-tool-call",
  ])("refuses %s sends", async (control) => {
    if (control === "foreign")
      manager = new DelegationManager(
        () => cwd,
        () => "foreign",
      );
    if (control === "no-owner") manager = new DelegationManager(() => cwd);
    if (control === "legacy") {
      const r = read();
      delete r.messagingProtocol;
      fs.writeFileSync(file, JSON.stringify(r));
    }
    if (control === "terminal") await failDelegation(file, "fixture finished");
    const result = await manager.sendMessage(
      control === "path" ? "../owned-worker" : "owned-worker",
      "Reply",
      control === "stale" ? "unknown-question" : undefined,
      control === "missing-tool-call" ? "" : "owner-send",
    );
    expect(result.success).toBe(false);
    expect(read().mailbox?.messages ?? []).toHaveLength(0);
  });
  it("refuses a reply to a progress message and an expired question", async () => {
    const progress = await appendWorkerMessage(file, "progress", "Working", "progress");
    expect((await manager.sendMessage("owned-worker", "reply", progress.id, "p-reply")).success).toBe(false);
    const q = await appendWorkerMessage(file, "question", "Wait?", "question", 10);
    await new Promise((r) => setTimeout(r, 20));
    expect((await manager.sendMessage("owned-worker", "late", q.id, "late-reply")).success).toBe(false);
  });
  it.each(["deadline", "cancel", "terminal"])("ends a %s question wait and releases the pause", async (control) => {
    const q = await appendWorkerMessage(file, "question", "Wait?", "question", control === "deadline" ? 25 : 1000);
    const controller = new AbortController();
    const waiting = waitForWorkerReply(file, q.id, controller.signal);
    if (control === "cancel") controller.abort();
    if (control === "terminal") await failDelegation(file, "fixture terminal");
    const result = await waiting;
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/deadline|cancel|terminal/i);
    expect(isInteractivePaused()).toBe(false);
  });
  it("reconciles a dead worker while an unanswered question is saved", async () => {
    await appendWorkerMessage(file, "question", "Waiting", "question", 1000);
    const r = read();
    r.pid = 2147483647;
    r.startedAt = new Date(0).toISOString();
    fs.writeFileSync(file, JSON.stringify(r));
    const result = await manager.waitResult("owned-worker");
    expect(result.success).toBe(false);
    expect(read().status).toBe("error");
  });
  it("enforces UTF8 size, total bytes and count bounds without mutating existing messages", async () => {
    await expect(
      appendWorkerMessage(file, "progress", "界".repeat(MESSAGE_LIMITS.messageBytes), "huge"),
    ).rejects.toThrow("size");
    const r = read();
    r.mailbox = { messages: [], nextSequence: 1, totalBytes: MESSAGE_LIMITS.totalBytes };
    fs.writeFileSync(file, JSON.stringify(r));
    await expect(appendWorkerMessage(file, "progress", "x", "total")).rejects.toThrow("capacity");
    r.mailbox.totalBytes = 0;
    r.mailbox.messages = Array.from({ length: MESSAGE_LIMITS.count }, (_, i) => ({
      id: String(i),
      sequence: i + 1,
      sender: "worker",
      kind: "progress",
      text: "x",
      toolCallId: String(i),
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(file, JSON.stringify(r));
    await expect(appendWorkerMessage(file, "progress", "x", "count")).rejects.toThrow("capacity");
  });
});
