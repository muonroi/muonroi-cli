import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ToolResult } from "../types/index.js";
import { withFileLock } from "../utils/file-lock.js";
import { loadDelegation, type StoredDelegation, writeDelegationRecord } from "./delegations.js";
import { beginBoundedWorkerWait, endBoundedWorkerWait } from "./interactive-pause.js";

/** Per-job lifetime limits. Delivery does not delete history or replenish capacity. */
export const MESSAGE_LIMITS = { count: 128, messageBytes: 8_000, totalBytes: 128_000, replyWaitMs: 300_000 } as const;
export interface DelegationMessage {
  id: string;
  sequence: number;
  sender: "main" | "worker";
  kind: "instruction" | "reply" | "progress" | "question";
  text: string;
  toolCallId: string;
  replyTo?: string;
  createdAt: string;
  deadlineAt?: string;
  replyTimeoutMs?: number;
  closedAt?: string;
  ownerDeliveredAt?: string;
  workerDeliveredAt?: string;
  writeScope?: string[];
  writeScopeVersion?: number;
}
export interface DelegationMailbox {
  messages: DelegationMessage[];
  nextSequence: number;
  totalBytes: number;
}

function validateMessage(text: string, toolCallId: string): void {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MESSAGE_LIMITS.messageBytes)
    throw new Error("message size must be 1..8000 UTF8 bytes.");
  if (typeof toolCallId !== "string" || !toolCallId.trim() || toolCallId.length > 256)
    throw new Error("message requires the actual SDK toolCallId (1..256 characters).");
}

export function pendingQuestion(record: StoredDelegation): DelegationMessage | undefined {
  if (record.status !== "running") return undefined;
  return record.mailbox?.messages.find(
    (m) =>
      m.sender === "worker" &&
      m.kind === "question" &&
      !m.closedAt &&
      Date.parse(m.deadlineAt ?? "") > Date.now() &&
      !record.mailbox!.messages.some((reply) => reply.sender === "main" && reply.replyTo === m.id),
  );
}

/** Called under the existing job lock. Caller identity is supplied by the host, never model input. */
export function appendMessage(
  record: StoredDelegation,
  sender: DelegationMessage["sender"],
  kind: DelegationMessage["kind"],
  text: string,
  toolCallId: string,
  replyTo?: string,
  waitMs?: number,
): DelegationMessage {
  validateMessage(text, toolCallId);
  if (
    (sender === "worker" && kind !== "progress" && kind !== "question") ||
    (sender === "main" && kind !== "instruction" && kind !== "reply")
  )
    throw new Error("message sender/kind mismatch.");
  if (kind === "question" && (!Number.isInteger(waitMs) || waitMs! < 1 || waitMs! > MESSAGE_LIMITS.replyWaitMs))
    throw new Error("question deadline must be 1..300000ms.");
  const mailbox = record.mailbox ?? { messages: [], nextSequence: 1, totalBytes: 0 };
  const previous = mailbox.messages.find((m) => m.sender === sender && m.toolCallId === toolCallId);
  if (previous) {
    if (
      previous.text !== text ||
      previous.kind !== kind ||
      previous.replyTo !== replyTo ||
      previous.replyTimeoutMs !== waitMs
    )
      throw new Error("message idempotency conflict: actual toolCallId already has different input.");
    return previous;
  }
  if (record.status !== "running" || record.kind === "council")
    throw new Error("message refused: job is terminal or has no worker mailbox.");
  if (kind === "question" && pendingQuestion(record))
    throw new Error("message refused: an unresolved worker question is already pending.");
  if (kind === "reply") {
    const question = mailbox.messages.find((m) => m.id === replyTo && m.sender === "worker" && m.kind === "question");
    if (!question || question.closedAt || Date.parse(question.deadlineAt ?? "") <= Date.now())
      throw new Error(
        "message reply correlation is missing, stale or expired. For a proactive instruction omit replyTo; a reply must use the exact pending worker question messageId.",
      );
    if (mailbox.messages.some((m) => m.replyTo === question.id))
      throw new Error("message reply conflict: question already answered.");
  } else if (replyTo !== undefined) throw new Error("message replyTo is valid only for a main reply.");
  const bytes = Buffer.byteLength(text, "utf8");
  if (mailbox.messages.length >= MESSAGE_LIMITS.count || mailbox.totalBytes + bytes > MESSAGE_LIMITS.totalBytes)
    throw new Error("message mailbox capacity exceeded.");
  const now = Date.now();
  const message: DelegationMessage = {
    id: randomUUID(),
    sequence: mailbox.nextSequence++,
    sender,
    kind,
    text,
    toolCallId,
    replyTo,
    createdAt: new Date(now).toISOString(),
    ...(kind === "question" ? { deadlineAt: new Date(now + waitMs!).toISOString(), replyTimeoutMs: waitMs } : {}),
  };
  mailbox.messages.push(message);
  mailbox.totalBytes += bytes;
  record.mailbox = mailbox;
  return message;
}

/** Host-bound worker endpoint: no recipient, role, model, grants or workspace fields. */
export async function appendWorkerMessage(
  jobPath: string,
  kind: "progress" | "question",
  text: string,
  toolCallId: string,
  waitMs: number = MESSAGE_LIMITS.replyWaitMs,
): Promise<DelegationMessage> {
  return withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    if (record.messagingProtocol !== 1)
      throw new Error("worker messaging protocol is unsupported; start a new worker.");
    if (!record.parentSessionId) throw new Error("worker mailbox requires an owning main session.");
    const message = appendMessage(
      record,
      "worker",
      kind,
      text,
      toolCallId,
      undefined,
      kind === "question" ? waitMs : undefined,
    );
    await writeDelegationRecord(jobPath, record);
    return message;
  });
}

export function formatWorkerMessages(record: StoredDelegation, messages: DelegationMessage[]): string {
  return [
    `[Worker messages jobId=${record.id} status=${record.status}]`,
    ...messages.map(
      (m) =>
        `[worker-message:${m.id}] messageId=${m.id} sequence=${m.sequence} sender=${m.sender} kind=${m.kind}${m.deadlineAt ? ` deadlineAt=${m.deadlineAt}` : ""}\n${m.text}`,
    ),
    "Reply to a question with delegation_send({id: jobId, message: answer, replyTo: messageId}). Messages do not verify or accept work.",
  ].join("\n\n");
}

/** Reattach bounded owner history after SDK compaction/prepareStep, without duplicating existing markers. */
export async function injectOwnerMessages(jobPath: string, messages: ModelMessage[]): Promise<ModelMessage[]> {
  return withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    if (record.status !== "running") return messages;
    const current = JSON.stringify(messages);
    const pending =
      record.mailbox?.messages.filter((m) => m.sender === "main" && !current.includes(`[owner-message:${m.id}]`)) ?? [];
    if (!pending.length) return messages;
    const injected: ModelMessage[] = [
      ...messages,
      ...pending.map((m) => ({
        role: "user" as const,
        content: `[owner-message:${m.id}] sequence=${m.sequence}${m.replyTo ? ` replyTo=${m.replyTo}` : ""}\n${m.text}\n${m.writeScopeVersion ? `[Host scope decision: writeScopeVersion=${m.writeScopeVersion} writeScope=${JSON.stringify(m.writeScope)}. Effective before the next write; earlier writes are not undone.]` : ""}\n[Host: prose does not change permissions. Only explicit host scope decisions replace file write paths. Tools, model, role, workspace and review restrictions remain fixed.]`,
      })),
    ];
    for (const m of pending) m.workerDeliveredAt ??= new Date().toISOString();
    await writeDelegationRecord(jobPath, record);
    return injected;
  });
}

/** Intentional host I/O wait. Never hold a file lock across the timer or reset hard budgets. */
export async function waitForWorkerReply(
  jobPath: string,
  questionId: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  beginBoundedWorkerWait();
  try {
    while (true) {
      const record = await loadDelegation(jobPath);
      const question = record.mailbox?.messages.find(
        (m) => m.id === questionId && m.sender === "worker" && m.kind === "question",
      );
      if (!question) return { success: false, output: "Worker question correlation is missing." };
      const reply = record.mailbox?.messages.find(
        (m) => m.sender === "main" && m.kind === "reply" && m.replyTo === questionId,
      );
      if (!signal?.aborted && record.status === "running" && !question.closedAt && reply)
        return {
          success: true,
          output: `jobId=${record.id} status=running messageId=${reply.id} replyTo=${questionId}${reply.writeScopeVersion ? ` writeScopeVersion=${reply.writeScopeVersion} writeScope=${JSON.stringify(reply.writeScope)}` : ""}\n${reply.text}`,
        };
      if (
        signal?.aborted ||
        record.status !== "running" ||
        question.closedAt ||
        Date.now() >= Date.parse(question.deadlineAt ?? "")
      ) {
        await withFileLock(jobPath, async () => {
          const current = await loadDelegation(jobPath);
          const q = current.mailbox?.messages.find((m) => m.id === questionId);
          if (q) {
            q.closedAt ??= new Date().toISOString();
            await writeDelegationRecord(jobPath, current);
          }
        });
        return {
          success: false,
          output: `Worker question messageId=${questionId} ended: ${signal?.aborted ? "cancelled" : record.status !== "running" ? "terminal job" : "reply deadline"}.`,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, Date.parse(question.deadlineAt!) - Date.now()))),
      );
    }
  } finally {
    endBoundedWorkerWait();
  }
}
