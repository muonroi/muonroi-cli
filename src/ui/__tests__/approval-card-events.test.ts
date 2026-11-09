import { redactEvent } from "@muonroi/agent-harness-core/event-redact";
import { describe, expect, it } from "vitest";
import { approvalOpenEvent, approvalQuestionId } from "../approval-card-events.js";

const tool = { toolCallId: "call-1", toolName: "read_file", preview: '{"file_path":"a.txt"}' };
const worker = {
  id: "req-9",
  jobId: "job-3",
  ownerId: "owner",
  toolName: "bash",
  toolCallId: "wcall-2",
  inputDigest: "abc",
  preview: '{"command":"ls"}',
  deadlineAt: "2026-11-09T00:00:00Z",
};

describe("approval card harness events", () => {
  it("tool approval opens as askcard-open with source + tool identity", () => {
    expect(approvalOpenEvent({ toolApproval: tool })).toEqual({
      t: "event",
      kind: "askcard-open",
      questionId: "tool-approval-call-1",
      question: "Tool approval: read_file",
      phase: "tool-approval",
      optionCount: 2,
      defaultIndex: 0,
      source: "tool-approval",
      toolName: "read_file",
      toolCallId: "call-1",
      preview: '{"file_path":"a.txt"}',
    });
  });

  it("worker approval carries the job id", () => {
    const e = approvalOpenEvent({ workerApproval: worker });
    expect(e).toMatchObject({
      questionId: "worker-approval-req-9",
      source: "worker-approval",
      phase: "worker-approval",
      toolName: "bash",
      jobId: "job-3",
    });
  });

  it("identity is stable across the Allow/Deny selection toggle and null for non-approvals", () => {
    expect(approvalQuestionId({ toolApproval: tool })).toBe(approvalQuestionId({ toolApproval: { ...tool } }));
    expect(approvalQuestionId(null)).toBeNull();
    expect(approvalQuestionId({})).toBeNull();
    expect(approvalOpenEvent({})).toBeNull();
  });

  it("wire redaction keeps the approval fields, caps and scrubs the preview", () => {
    const e = approvalOpenEvent({
      toolApproval: { ...tool, preview: `key sk-1234567890abcdefghij ${"x ".repeat(200)}` },
    })!;
    const out = redactEvent(e) as typeof e;
    expect(out.source).toBe("tool-approval");
    expect(out.toolName).toBe("read_file");
    expect(out.toolCallId).toBe("call-1");
    expect(out.preview!.length).toBeLessThanOrEqual(300);
    expect(out.preview).toContain("[redacted]");
  });
});
