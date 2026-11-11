import { parsePermissionMode } from "../../utils/permission-mode.js";
import { saveUserSettings } from "../../utils/settings.js";
import { statusBarStore } from "../../state/status-bar-store.js";
import { logger } from "../../utils/logger.js";
import { registerSlash, type SlashHandler } from "./registry.js";

export const handlePermissionsSlash: SlashHandler = async (args, ctx) => {
  if (!args.length || args[0] === "status")
    return `Permissions: ${ctx.getPermissionMode?.() ?? "unavailable"}. /permissions safe|auto|yolo. Auto approves file operations and non-dangerous shell; other tools may require approval. Yolo approves standard tool permissions. Custom business approvals, workflow and catastrophic-command guards remain active. Selection applies to this session/owned running workers and saves the next CLI default.`;
  if (args.length !== 1 || !ctx.setPermissionMode)
    return "Usage: /permissions safe|auto|yolo (requires a live owning CLI).";
  let mode: ReturnType<typeof parsePermissionMode>;
  try {
    mode = parsePermissionMode(args[0]);
  } catch (error) {
    logger.file("debug", "ui", "Invalid permission selection", { error: String(error) });
    return error instanceof Error ? error.message : String(error);
  }
  const updated = await ctx.setPermissionMode(mode);
  saveUserSettings({ permissionMode: mode });
  statusBarStore.setState({ permission_mode: mode });
  return `Permissions: ${mode === "auto-edit" ? "Auto" : mode}. Updated ${updated} owned running worker(s); saved as the next CLI default. No expired/denied approval was revived. Custom business approvals and workflow guards remain active.`;
};
registerSlash("permissions", handlePermissionsSlash);
