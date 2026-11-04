import { createHash, randomUUID } from "node:crypto";
import type { ToolSet } from "ai";
import { withFileLock } from "../utils/file-lock.js";
import { logger, redactSecrets } from "../utils/logger.js";
import { type PermissionMode, toolNeedsApproval } from "../utils/permission-mode.js";
import { loadDelegation, type StoredDelegation, writeDelegationRecord } from "./delegations.js";
import { beginBoundedWorkerWait, endBoundedWorkerWait } from "./interactive-pause.js";

export const WORKER_APPROVAL_LIMITS = {
  count: 128,
  pending: 16,
  waitMs: 300_000,
  leaseMs: 15_000,
  previewChars: 65536,
} as const;
export interface WorkerApprovalController {
  digest: string;
  pid: number;
  expiresAt: string;
}
export interface WorkerApprovalRequest {
  id: string;
  jobId: string;
  ownerId: string;
  controllerDigest: string;
  toolName: string;
  toolCallId: string;
  inputDigest: string;
  preview: string;
  createdAt: string;
  deadlineAt: string;
  state: "pending" | "approved" | "denied" | "consumed" | "expired" | "cancelled";
  decidedAt?: string;
  consumedAt?: string;
  reason?: string;
  policyRequired?: boolean;
  autoEditAllowed?: boolean;
}
/** The UI receives correlation, never the private controller credential or raw input. */
export type WorkerApprovalView = Pick<
  WorkerApprovalRequest,
  "id" | "jobId" | "ownerId" | "toolName" | "toolCallId" | "inputDigest" | "preview" | "deadlineAt"
>;
export function approvalDigest(input: unknown): string {
  const encoded = JSON.stringify(input);
  if (encoded === undefined) throw new Error("permission_required: approval input is not JSON serializable.");
  return createHash("sha256").update(encoded).digest("hex");
}
function liveController(record: StoredDelegation): boolean {
  const controller = record.approvalController;
  if (!controller || !(Date.parse(controller.expiresAt) > Date.now())) return false;
  try {
    process.kill(controller.pid, 0);
    return true;
  } catch (err) {
    logger.file("warn", "orchestrator", "Worker approval owner liveness failed", {
      jobId: record.id,
      error: String(err),
    });
    return false;
  }
}
function assertLive(record: StoredDelegation, signal?: AbortSignal): void {
  if (signal?.aborted || record.status !== "running")
    throw new Error("permission_required: worker cancelled or terminal; tool did not execute.");
  if (!record.parentSessionId || !liveController(record))
    throw new Error(
      "permission_required: no live owner approval UI. Open a live TUI and launch a new worker; tool did not execute.",
    );
}
function audit(request: WorkerApprovalRequest): void {
  logger.file("info", "orchestrator", "Worker tool approval", {
    jobId: request.jobId,
    requestId: request.id,
    ownerId: request.ownerId,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    inputDigest: request.inputDigest,
    state: request.state,
    reason: request.reason,
  });
}
export function pendingWorkerApprovals(record: StoredDelegation): WorkerApprovalView[] {
  if (record.status !== "running" || !liveController(record)) return [];
  return (record.approvals ?? [])
    .filter(
      (r) =>
        r.state === "pending" &&
        r.controllerDigest === record.approvalController?.digest &&
        Date.parse(r.deadlineAt) > Date.now(),
    )
    .map(({ id, jobId, ownerId, toolName, toolCallId, inputDigest, preview, deadlineAt }) => ({
      id,
      jobId,
      ownerId,
      toolName,
      toolCallId,
      inputDigest,
      preview,
      deadlineAt,
    }));
}
/** Host-owned mode selection applies to live standard grants, never custom business approval. */
export function applyWorkerPermissionMode(record: StoredDelegation, mode: PermissionMode): void {
  record.permissionMode = mode;
  if (record.status !== "running" || !liveController(record)) return;
  for (const request of record.approvals ?? []) {
    if (
      request.ownerId !== record.parentSessionId ||
      request.jobId !== record.id ||
      request.controllerDigest !== record.approvalController?.digest ||
      Date.parse(request.deadlineAt) <= Date.now()
    )
      continue;
    const allowed =
      request.policyRequired === false &&
      (mode === "yolo" || (mode === "auto-edit" && request.autoEditAllowed === true));
    if (request.state === "pending" && allowed) {
      request.state = "approved";
      request.decidedAt = new Date().toISOString();
      request.reason = `owner selected permission mode ${mode}`;
      audit(request);
    } else if (
      request.state === "approved" &&
      request.reason?.startsWith("owner selected permission mode") &&
      !allowed
    ) {
      request.state = "pending";
      delete request.decidedAt;
      delete request.reason;
      audit(request);
    }
  }
}
/** Host callback only. This function is deliberately absent from native/model tools. */
export async function decideWorkerApproval(
  jobPath: string,
  ownerId: string,
  controllerDigest: string,
  view: WorkerApprovalView,
  approved: boolean,
): Promise<void> {
  await withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    assertLive(record);
    const request = record.approvals?.find((r) => r.id === view.id);
    if (
      record.parentSessionId !== ownerId ||
      record.id !== view.jobId ||
      view.ownerId !== ownerId ||
      record.approvalController?.digest !== controllerDigest ||
      !request ||
      request.controllerDigest !== controllerDigest ||
      request.ownerId !== ownerId ||
      request.jobId !== record.id ||
      request.state !== "pending" ||
      !(Date.parse(request.deadlineAt) > Date.now()) ||
      request.deadlineAt !== view.deadlineAt ||
      request.toolName !== view.toolName ||
      request.toolCallId !== view.toolCallId ||
      request.inputDigest !== view.inputDigest
    )
      throw new Error("permission_required: stale, foreign or changed worker approval.");
    request.state = approved ? "approved" : "denied";
    request.decidedAt = new Date().toISOString();
    await writeDelegationRecord(jobPath, record);
    audit(request);
  });
}
/** Wait outside locks; consume once with exact arguments and cancellation winning. */
export async function requestWorkerApproval(
  jobPath: string,
  toolName: string,
  input: unknown,
  toolCallId: string,
  signal?: AbortSignal,
  timeoutMs: number = WORKER_APPROVAL_LIMITS.waitMs,
  policyRequired = false,
): Promise<void> {
  if (
    !toolCallId ||
    toolCallId.length > 256 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > WORKER_APPROVAL_LIMITS.waitMs
  )
    throw new Error("permission_required: invalid tool call correlation or deadline.");
  const digest = approvalDigest(input);
  const preview = redactSecrets(
    JSON.stringify(input, (key, value) =>
      /secret|token|password|api.?key|authorization|cookie/i.test(key) ? "[REDACTED]" : value,
    ),
  );
  if (preview.length > WORKER_APPROVAL_LIMITS.previewChars) {
    logger.file("warn", "orchestrator", "Worker approval preview refused", {
      jobPath,
      toolName,
      toolCallId,
      inputDigest: digest,
      previewChars: preview.length,
      limit: WORKER_APPROVAL_LIMITS.previewChars,
      reason: "approval_preview_too_large",
    });
    throw new Error(
      `permission_required: approval_preview_too_large: full redacted input is ${preview.length} characters (limit ${WORKER_APPROVAL_LIMITS.previewChars}). No request was created or tool executed. For trusted larger atomic operations the user can explicitly select Auto/Yolo; do not split or truncate the write automatically.`,
    );
  }
  const request = await withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    assertLive(record, signal);
    const requests = (record.approvals ??= []);
    if (
      requests.length >= WORKER_APPROVAL_LIMITS.count ||
      requests.filter((r) => r.state === "pending").length >= WORKER_APPROVAL_LIMITS.pending ||
      requests.some((r) => r.toolCallId === toolCallId)
    )
      throw new Error("permission_required: approval replay or queue capacity exceeded.");
    const now = Date.now();
    const created: WorkerApprovalRequest = {
      id: randomUUID(),
      jobId: record.id,
      ownerId: record.parentSessionId!,
      controllerDigest: record.approvalController!.digest,
      toolName,
      toolCallId,
      inputDigest: digest,
      preview,
      policyRequired,
      autoEditAllowed: !toolNeedsApproval(
        toolName,
        "auto-edit",
        input && typeof input === "object" ? input : undefined,
      ),
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeoutMs).toISOString(),
      state: "pending",
    };
    requests.push(created);
    if (record.permissionMode) applyWorkerPermissionMode(record, record.permissionMode);
    await writeDelegationRecord(jobPath, record);
    audit(created);
    return created;
  });
  beginBoundedWorkerWait();
  try {
    while (true) {
      const outcome = await withFileLock(jobPath, async () => {
        const record = await loadDelegation(jobPath);
        const current = record.approvals?.find((r) => r.id === request.id);
        if (!current) throw new Error("permission_required: worker approval correlation missing.");
        const changed =
          approvalDigest(input) !== digest ||
          current.inputDigest !== digest ||
          current.toolName !== toolName ||
          current.toolCallId !== toolCallId ||
          current.ownerId !== request.ownerId ||
          current.ownerId !== record.parentSessionId ||
          current.jobId !== request.jobId ||
          current.jobId !== record.id ||
          current.controllerDigest !== request.controllerDigest ||
          current.controllerDigest !== record.approvalController?.digest ||
          current.deadlineAt !== request.deadlineAt;
        const cancelled = signal?.aborted || record.status !== "running" || !liveController(record) || changed;
        const expired = !(Date.parse(current.deadlineAt) > Date.now());
        if (cancelled || expired) {
          current.state = expired ? "expired" : "cancelled";
          current.reason = changed
            ? "changed input or ownership"
            : expired
              ? "approval deadline"
              : "cancelled, terminal or owner unavailable";
          await writeDelegationRecord(jobPath, record);
          audit(current);
          throw new Error(`permission_required: ${current.reason}; tool did not execute.`);
        }
        if (current.state === "pending") return false;
        if (current.state !== "approved")
          throw new Error(`permission_required: worker approval ${current.state}; tool did not execute.`);
        current.state = "consumed";
        current.consumedAt = new Date().toISOString();
        await writeDelegationRecord(jobPath, record);
        audit(current);
        return true;
      });
      if (outcome) {
        if (signal?.aborted) throw new Error("permission_required: cancelled before execution.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    endBoundedWorkerWait();
  }
}

/** An owned clone prevents the SDK from pausing before our SDK-and-batch gate. */
export function gateWorkerTools(
  tools: ToolSet,
  mode: PermissionMode | undefined | (() => Promise<PermissionMode | undefined>),
  approve:
    | ((
        toolName: string,
        input: unknown,
        toolCallId: string,
        signal?: AbortSignal,
        policyRequired?: boolean,
      ) => Promise<void>)
    | undefined,
  outerSignal?: AbortSignal,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const policy = tool.needsApproval;
      if (!tool.execute) {
        if (policy !== undefined && policy !== false)
          throw new Error(`permission_required: unsupported approval metadata on non-executable worker tool ${name}.`);
        return [name, tool];
      }
      const execute = tool.execute;
      return [
        name,
        {
          ...tool,
          needsApproval: false,
          execute: async (input: any, context: any) => {
            const signal =
              outerSignal && context?.abortSignal
                ? AbortSignal.any([outerSignal, context.abortSignal])
                : (outerSignal ?? context?.abortSignal);
            if (signal?.aborted) throw new Error("permission_required: cancelled before tool execution.");
            let customApproval = false;
            if (typeof policy === "function")
              customApproval = await policy.call(tool, input, {
                toolCallId: context.toolCallId,
                messages: context.messages,
                experimental_context: context.experimental_context,
              });
            else if (typeof policy === "boolean") customApproval = policy;
            else if (policy !== undefined)
              throw new Error(`permission_required: unsupported worker approval metadata for ${name}.`);
            if (typeof customApproval !== "boolean")
              throw new Error(`permission_required: unsupported approval predicate result for ${name}.`);
            const effectiveMode = typeof mode === "function" ? await mode() : mode;
            if (
              customApproval ||
              (effectiveMode &&
                toolNeedsApproval(name, effectiveMode, input && typeof input === "object" ? input : undefined))
            ) {
              if (!approve)
                throw new Error("permission_required: no live owner approval channel; tool did not execute.");
              const digest = approvalDigest(input);
              await approve(name, input, context?.toolCallId, signal, customApproval);
              if (approvalDigest(input) !== digest)
                throw new Error("permission_required: changed input after approval; tool did not execute.");
            }
            if (signal?.aborted) throw new Error("permission_required: cancelled before tool execution.");
            return execute(input, context);
          },
        },
      ];
    }),
  );
}
