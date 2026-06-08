/**
 * Permission mode controls which tool calls require manual approval before execution.
 *
 * safe      - Every tool call prompts the user for approval.
 * auto-edit - File operation tools (read/write/edit/grep/list) auto-approve;
 *             shell execution and computer tools still require confirmation.
 * yolo      - All tool calls auto-approve without any prompting.
 */
import { appendDecisionLog } from "../usage/decision-log.js";

export type PermissionMode = "safe" | "auto-edit" | "yolo";

/**
 * Set of tool names that are auto-approved in auto-edit mode.
 * These are read/write file operations that are considered safe to run
 * without manual confirmation when the user has opted into auto-edit mode.
 */
export const AUTO_EDIT_ALLOWED: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "list_directory",
]);

/**
 * Returns true if the given tool call requires manual user approval
 * under the specified permission mode.
 *
 * @param toolName - The name of the tool being invoked.
 * @param mode     - The active PermissionMode.
 * @param context  - Optional context (command string for bash, path, isNetwork).
 *                   Backward compatible: old callers passing 2 args unchanged.
 * @returns true if the tool needs user approval, false if it should auto-approve.
 */
export function toolNeedsApproval(
  toolName: string,
  mode: PermissionMode,
  context?: { command?: string; path?: string; isNetwork?: boolean }
): boolean {
  const dangerous = (cmd?: string): boolean => {
    if (!cmd) return false;
    const patterns: RegExp[] = [
      /rm\s+-rf?\s+\/(?!tmp|var\/tmp)/i,
      /curl\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      /wget\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      /chmod\s+777/i,
      /eval\s*\(/i,
      /exec\s*\(/i,
    ];
    return patterns.some((p) => p.test(cmd));
  };

  if (mode === "yolo") {
    if (dangerous(context?.command)) {
      appendAudit({
        kind: "yolo-override",
        tool: toolName,
        mode,
        context,
        ts: Date.now(),
      });
    }
    return false;
  }
  if (mode === "auto-edit") {
    if (toolName === "bash" && dangerous(context?.command)) return true;
    return !AUTO_EDIT_ALLOWED.has(toolName);
  }
  // "safe" — always confirm; dangerous patterns explicitly require (no bypass)
  if (dangerous(context?.command)) return true;
  return true;
}

type AuditEvent = {
  kind: "permission-override" | "yolo-override";
  tool: string;
  mode: PermissionMode;
  context?: any;
  ts: number;
};

export function appendAudit(event: AuditEvent): void {
  // fire-and-forget; must not block sync approval decision path
  appendDecisionLog({
    ts: event.ts,
    kind: event.kind as any,
    taken: true,
    reason: `${event.kind} for ${event.tool} under ${event.mode}`,
    meta: { context: event.context },
  }).catch(() => {
    // swallow per decision-log contract
  });
}
