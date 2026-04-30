/**
 * Permission mode controls which tool calls require manual approval before execution.
 *
 * safe      - Every tool call prompts the user for approval.
 * auto-edit - File operation tools (read/write/edit/grep/list) auto-approve;
 *             shell execution and computer tools still require confirmation.
 * yolo      - All tool calls auto-approve without any prompting.
 */
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
 * @returns true if the tool needs user approval, false if it should auto-approve.
 */
export function toolNeedsApproval(toolName: string, mode: PermissionMode): boolean {
  if (mode === "yolo") return false;
  if (mode === "auto-edit") return !AUTO_EDIT_ALLOWED.has(toolName);
  // "safe" — always confirm
  return true;
}
