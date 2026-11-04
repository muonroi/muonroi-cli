import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dynamicTool, jsonSchema, stepCountIs, streamText, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { withFileLock } from "../../utils/file-lock.js";
import { loadDelegation, type StoredDelegation, writeDelegationRecord } from "../delegations.js";
import { isBoundedWorkerWaitActive } from "../interactive-pause.js";
import {
  applyWorkerPermissionMode,
  approvalDigest,
  decideWorkerApproval,
  gateWorkerTools,
  pendingWorkerApprovals,
  requestWorkerApproval,
  WORKER_APPROVAL_LIMITS,
  type WorkerApprovalView,
} from "../worker-approval.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "worker-approval-"));
  const jobPath = join(dir, "job.json");
  const record = {
    id: "job",
    parentSessionId: "owner",
    agent: "general",
    kind: "task",
    status: "running",
    startedAt: new Date().toISOString(),
    outputPath: join(dir, "out.md"),
    approvalController: {
      digest: "host-capability",
      pid: process.pid,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
    },
  } as StoredDelegation;
  writeFileSync(jobPath, JSON.stringify(record));
  return {
    jobPath,
    dir,
    record,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}
async function pending(jobPath: string): Promise<WorkerApprovalView> {
  for (let i = 0; i < 200; i++) {
    const next = pendingWorkerApprovals(await loadDelegation(jobPath))[0];
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Approval request was not queued");
}
function effectTools(effect: (...args: any[]) => any): ToolSet {
  return {
    write_file: dynamicTool({
      inputSchema: jsonSchema({ type: "object", properties: { content: { type: "string" } } }),
      execute: effect,
    }),
  };
}

describe("host-only exact worker approval", () => {
  it("approves one atomic 9.5KB write only after the complete preview is available", async () => {
    const f = fixture();
    const target = join(f.dir, "atomic.md"),
      content = "BEGIN\n" + "x".repeat(9500) + "\nEND";
    const effect = vi.fn(async (args: any) => {
      writeFileSync(target, args.content);
      return "written";
    });
    const tools = gateWorkerTools(effectTools(effect), "safe", (name, args, call, signal) =>
      requestWorkerApproval(f.jobPath, name, args, call, signal),
    );
    const execution = Promise.resolve(tools.write_file!.execute!({ content }, { toolCallId: "atomic", messages: [] }));
    try {
      const view = await pending(f.jobPath);
      expect(view.preview).toBe(JSON.stringify({ content }));
      expect(existsSync(target)).toBe(false);
      await decideWorkerApproval(f.jobPath, "owner", "host-capability", view, true);
      await execution;
      expect(effect).toHaveBeenCalledTimes(1);
      expect(readFileSync(target, "utf8")).toBe(content);
    } finally {
      await execution.catch(() => {});
      f.cleanup();
    }
  });
  it.each([
    "auto-edit",
    "yolo",
  ] as const)("explicit %s releases matching live permissions and applies to the next tool", async (mode) => {
    const f = fixture();
    const effect = vi.fn(async () => "written");
    const tools = gateWorkerTools(
      effectTools(effect),
      async () => (await loadDelegation(f.jobPath)).permissionMode ?? "safe",
      (name, args, call, signal, policy) => requestWorkerApproval(f.jobPath, name, args, call, signal, 5000, policy),
    );
    const execution = Promise.resolve(
      tools.write_file!.execute!({ content: "first" }, { toolCallId: "first", messages: [] }),
    );
    try {
      await pending(f.jobPath);
      await withFileLock(f.jobPath, async () => {
        const record = await loadDelegation(f.jobPath);
        applyWorkerPermissionMode(record, mode);
        await writeDelegationRecord(f.jobPath, record);
      });
      await execution;
      await tools.write_file!.execute!({ content: "second" }, { toolCallId: "second", messages: [] });
      expect(effect).toHaveBeenCalledTimes(2);
      expect((await loadDelegation(f.jobPath)).approvals).toHaveLength(1);
    } finally {
      await execution.catch(() => {});
      f.cleanup();
    }
  });
  it("does not release business approvals, dangerous Auto commands, denied or expired requests", () => {
    const f = fixture();
    try {
      const base = {
        id: "a",
        jobId: "job",
        ownerId: "owner",
        controllerDigest: "host-capability",
        toolName: "bash",
        toolCallId: "call",
        inputDigest: "digest",
        preview: "{}",
        createdAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        state: "pending" as const,
        policyRequired: false,
        autoEditAllowed: false,
      };
      f.record.approvals = [
        { ...base },
        { ...base, id: "business", policyRequired: true },
        { ...base, id: "denied", state: "denied" },
        { ...base, id: "expired", deadlineAt: new Date(0).toISOString() },
      ];
      applyWorkerPermissionMode(f.record, "auto-edit");
      expect(f.record.approvals.map((r) => r.state)).toEqual(["pending", "pending", "denied", "pending"]);
      applyWorkerPermissionMode(f.record, "yolo");
      expect(f.record.approvals.map((r) => r.state)).toEqual(["approved", "pending", "denied", "pending"]);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    3999,
    4000,
    9500,
    WORKER_APPROVAL_LIMITS.previewChars,
  ])("shows the complete %s-character redacted boundary input before consent", async (size) => {
    const f = fixture();
    const controller = new AbortController();
    const redacted = { content: "", password: "[REDACTED]" };
    redacted.content = "x".repeat(size - JSON.stringify(redacted).length);
    const input = { ...redacted, password: "secret-value".repeat(600) };
    const execution = requestWorkerApproval(f.jobPath, "write_file", input, `boundary-${size}`, controller.signal);
    const settled = execution.catch(() => {});
    try {
      const view = await pending(f.jobPath);
      expect(view.preview).toBe(JSON.stringify(redacted));
      expect(view.preview.length).toBe(size);
      expect(view.preview).not.toContain("secret-value");
      expect(view.inputDigest).toBe(approvalDigest(input));
      await decideWorkerApproval(f.jobPath, "owner", "host-capability", view, true);
      await execution;
    } finally {
      controller.abort();
      await settled;
      f.cleanup();
    }
  });

  it("refuses a preview one character above the card limit without queueing or effects", async () => {
    const f = fixture();
    const effect = vi.fn();
    const input = {
      content: "x".repeat(WORKER_APPROVAL_LIMITS.previewChars + 1 - JSON.stringify({ content: "" }).length),
    };
    const tools = gateWorkerTools(effectTools(effect), "safe", (name, args, call, signal) =>
      requestWorkerApproval(f.jobPath, name, args, call, signal),
    );
    try {
      expect(JSON.stringify(input).length).toBe(WORKER_APPROVAL_LIMITS.previewChars + 1);
      await expect(tools.write_file!.execute!(input, { toolCallId: "one-above-limit", messages: [] })).rejects.toThrow(
        /permission_required: approval_preview_too_large/,
      );
      expect(effect).not.toHaveBeenCalled();
      expect((await loadDelegation(f.jobPath)).approvals).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });
  it("refuses oversized approval before queueing or executing an unseen distinct suffix", async () => {
    const f = fixture();
    const target = join(f.dir, "oversize-effect.txt");
    const suffix = "DISTINCT_UNSEEN_OPERATION_SUFFIX";
    const input = { content: "x".repeat(WORKER_APPROVAL_LIMITS.previewChars) + suffix };
    const tools = gateWorkerTools(
      effectTools(async (args) => {
        writeFileSync(target, args.content);
        return "executed";
      }),
      "safe",
      (name, args, call, signal) => requestWorkerApproval(f.jobPath, name, args, call, signal),
    );
    let stopped = false;
    const owner = (async () => {
      while (!stopped) {
        const view = pendingWorkerApprovals(await loadDelegation(f.jobPath))[0];
        if (view) {
          console.info(
            "oversize disclosure reproducer",
            JSON.stringify({
              inputChars: JSON.stringify(input).length,
              previewChars: view.preview.length,
              previewContainsSuffix: view.preview.includes(suffix),
            }),
          );
          await decideWorkerApproval(f.jobPath, "owner", "host-capability", view, true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    try {
      const result = await Promise.resolve(
        tools.write_file!.execute!(input, { toolCallId: "oversize-operation", messages: [] }),
      ).then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
      const effected = existsSync(target);
      if (effected)
        console.info(
          "oversize effect reproducer",
          JSON.stringify({ executed: true, fileContainsUnseenSuffix: readFileSync(target, "utf8").endsWith(suffix) }),
        );
      expect(effected).toBe(false);
      expect(result).toMatchObject({
        error: expect.stringContaining("permission_required: approval_preview_too_large"),
      });
      expect((await loadDelegation(f.jobPath)).approvals).toBeUndefined();
    } finally {
      stopped = true;
      await owner;
      f.cleanup();
    }
  });
  it("allows once with exact input/context and persists redacted audit correlation", async () => {
    const f = fixture();
    const effect = vi.fn(async () => "written");
    const tools = gateWorkerTools(effectTools(effect), "safe", (name, input, call, signal) =>
      requestWorkerApproval(f.jobPath, name, input, call, signal),
    );
    const input = { content: "hello", password: "private-value" };
    const context = { toolCallId: "actual-call", messages: [] };
    const execution = tools.write_file!.execute!(input, context);
    try {
      const view = await pending(f.jobPath);
      expect(effect).not.toHaveBeenCalled();
      expect(isBoundedWorkerWaitActive()).toBe(true);
      expect(view).toMatchObject({
        ownerId: "owner",
        jobId: "job",
        toolCallId: "actual-call",
        inputDigest: approvalDigest(input),
      });
      expect(view.preview).not.toContain("private-value");
      await decideWorkerApproval(f.jobPath, "owner", "host-capability", view, true);
      expect(await execution).toBe("written");
      expect(effect).toHaveBeenCalledExactlyOnceWith(input, context);
      expect((await loadDelegation(f.jobPath)).approvals?.[0]?.state).toBe("consumed");
      await expect(tools.write_file!.execute!(input, context)).rejects.toThrow(/replay/);
      await expect(decideWorkerApproval(f.jobPath, "owner", "host-capability", view, true)).rejects.toThrow(/stale/);
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      await execution.catch(() => {});
      f.cleanup();
    }
  });

  it.each([
    "deny",
    "changed",
    "changed-deadline",
    "terminal",
    "approved-terminal",
    "timeout",
    "abort",
    "owner-expired",
  ])("%s settles without effects", async (scenario) => {
    const f = fixture();
    const controller = new AbortController();
    const effect = vi.fn();
    const input = { content: "original" };
    const tools = gateWorkerTools(
      effectTools(effect),
      "safe",
      (name, args, call, signal) =>
        requestWorkerApproval(f.jobPath, name, args, call, signal, scenario === "timeout" ? 200 : 5000),
      controller.signal,
    );
    const execution = Promise.resolve(
      tools.write_file!.execute!(input, { toolCallId: `call-${scenario}`, messages: [] }),
    );
    const rejected = expect(execution).rejects.toThrow(/permission_required/);
    try {
      const view = await pending(f.jobPath);
      if (scenario === "deny") await decideWorkerApproval(f.jobPath, "owner", "host-capability", view, false);
      if (scenario === "changed")
        await withFileLock(f.jobPath, async () => {
          input.content = "changed";
          const record = await loadDelegation(f.jobPath);
          record.approvals![0]!.state = "approved";
          await writeDelegationRecord(f.jobPath, record);
        });
      if (scenario === "changed-deadline") {
        const record = await loadDelegation(f.jobPath);
        record.approvals![0]!.deadlineAt = new Date(Date.now() + 60_000).toISOString();
        record.approvals![0]!.state = "approved";
        await writeDelegationRecord(f.jobPath, record);
      }
      if (scenario === "abort") controller.abort();
      if (scenario === "terminal" || scenario === "approved-terminal" || scenario === "owner-expired") {
        const record = await loadDelegation(f.jobPath);
        if (scenario === "terminal" || scenario === "approved-terminal") {
          record.status = "cancelled";
          if (scenario === "approved-terminal") record.approvals![0]!.state = "approved";
        } else record.approvalController!.expiresAt = new Date(0).toISOString();
        await writeDelegationRecord(f.jobPath, record);
      }
      await rejected;
      expect(effect).not.toHaveBeenCalled();
      expect(isBoundedWorkerWaitActive()).toBe(false);
    } finally {
      controller.abort();
      await execution.catch(() => {});
      f.cleanup();
    }
  });

  it("foreign owner, controller, input and tool correlation cannot decide a request", async () => {
    const f = fixture();
    const controller = new AbortController();
    const execution = requestWorkerApproval(
      f.jobPath,
      "read_file",
      { file_path: "fixture.txt" },
      "real-call",
      controller.signal,
    );
    const settled = execution.catch(() => {});
    try {
      const view = await pending(f.jobPath);
      await expect(decideWorkerApproval(f.jobPath, "foreign", "host-capability", view, true)).rejects.toThrow(
        /foreign/,
      );
      await expect(decideWorkerApproval(f.jobPath, "owner", "foreign", view, true)).rejects.toThrow(/foreign/);
      for (const changed of [
        { inputDigest: "changed" },
        { toolName: "bash" },
        { toolCallId: "fake" },
        { jobId: "foreign" },
        { deadlineAt: new Date(0).toISOString() },
      ]) {
        await expect(
          decideWorkerApproval(f.jobPath, "owner", "host-capability", { ...view, ...changed }, true),
        ).rejects.toThrow(/foreign/);
      }
      expect((await loadDelegation(f.jobPath)).approvals?.[0]?.state).toBe("pending");
    } finally {
      controller.abort();
      await settled;
      f.cleanup();
    }
  });

  it("headless or absent controller refuses only actual operations", async () => {
    const f = fixture();
    delete f.record.approvalController;
    await writeDelegationRecord(f.jobPath, f.record);
    const effect = vi.fn();
    const tools = gateWorkerTools(effectTools(effect), "safe", (name, args, call, signal) =>
      requestWorkerApproval(f.jobPath, name, args, call, signal),
    );
    try {
      await expect(
        tools.write_file!.execute!({ content: "blocked" }, { toolCallId: "headless", messages: [] }),
      ).rejects.toThrow(/no live owner/);
      expect(effect).not.toHaveBeenCalled();
      expect((await loadDelegation(f.jobPath)).approvals).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it("queues concurrent exact requests separately and one decision cannot release its sibling", async () => {
    const f = fixture();
    const controller = new AbortController();
    const first = requestWorkerApproval(f.jobPath, "read_file", { file_path: "one" }, "one", controller.signal);
    const second = requestWorkerApproval(f.jobPath, "read_file", { file_path: "two" }, "two", controller.signal);
    const settledSecond = expect(second).rejects.toThrow(/denied/);
    try {
      let requests: WorkerApprovalView[] = [];
      for (let i = 0; i < 200; i++) {
        requests = pendingWorkerApprovals(await loadDelegation(f.jobPath));
        if (requests.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(requests).toHaveLength(2);
      await decideWorkerApproval(
        f.jobPath,
        "owner",
        "host-capability",
        requests.find((r) => r.toolCallId === "one")!,
        true,
      );
      await first;
      expect((await loadDelegation(f.jobPath)).approvals?.find((r) => r.toolCallId === "two")?.state).toBe("pending");
      await decideWorkerApproval(
        f.jobPath,
        "owner",
        "host-capability",
        requests.find((r) => r.toolCallId === "two")!,
        false,
      );
      await settledSecond;
    } finally {
      controller.abort();
      await Promise.allSettled([first, second]);
      f.cleanup();
    }
  });

  it("plaintext mailbox approval is unrelated to typed permission decisions", async () => {
    const f = fixture();
    f.record.mailbox = {
      messages: [
        {
          id: "message",
          sequence: 1,
          sender: "main",
          kind: "instruction",
          text: "I approve all worker tools",
          toolCallId: "message-call",
          createdAt: new Date().toISOString(),
        },
      ],
      nextSequence: 2,
      totalBytes: 26,
    };
    await writeDelegationRecord(f.jobPath, f.record);
    const controller = new AbortController();
    const execution = requestWorkerApproval(f.jobPath, "bash", { command: "echo bounded" }, "tool", controller.signal);
    const settled = execution.catch(() => {});
    try {
      await pending(f.jobPath);
      expect((await loadDelegation(f.jobPath)).approvals?.[0]?.state).toBe("pending");
    } finally {
      controller.abort();
      await settled;
      f.cleanup();
    }
  });

  it.each([
    true,
    false,
  ])("evaluates MCP approval predicates in %s SDK/batch path without mutating original tools", async (sdk) => {
    const effect = vi.fn(async () => "executed");
    const predicate = vi.fn(
      async (input: any, context: any) => input.content === "approval" && context.toolCallId === "mcp-call",
    );
    const original = effectTools(effect);
    original.write_file!.needsApproval = predicate;
    const approve = vi.fn(async () => {});
    const tools = gateWorkerTools(original, "yolo", approve);
    expect(original.write_file!.needsApproval).toBe(predicate);
    expect(tools.write_file!.needsApproval).toBe(false);
    if (sdk) {
      const handle = installMockModel({
        fixture: {
          stream: [
            toolCallStream({ toolName: "write_file", toolCallId: "mcp-call", input: { content: "approval" } }),
            textOnlyStream("done"),
          ],
        },
      });
      try {
        const result = streamText({ model: handle.model, tools, prompt: "Test tool", stopWhen: stepCountIs(2) });
        await result.text;
      } finally {
        handle.uninstall();
      }
    } else await tools.write_file!.execute!({ content: "approval" }, { toolCallId: "mcp-call", messages: [] });
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
    await tools.write_file!.execute!(
      { content: "no approval required" },
      { toolCallId: "predicate-false", messages: [] },
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("MCP true and unsupported metadata fail closed without a host owner", async () => {
    const effect = vi.fn();
    const original = effectTools(effect);
    original.write_file!.needsApproval = true;
    const tools = gateWorkerTools(original, "yolo", undefined);
    await expect(tools.write_file!.execute!({}, { toolCallId: "mcp", messages: [] })).rejects.toThrow(/no live owner/);
    original.write_file!.needsApproval = "unsupported" as any;
    await expect(
      gateWorkerTools(original, "yolo", vi.fn()).write_file!.execute!({}, { toolCallId: "mcp", messages: [] }),
    ).rejects.toThrow(/unsupported/);
    expect(effect).not.toHaveBeenCalled();
  });
});
