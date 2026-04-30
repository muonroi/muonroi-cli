/**
 * /expand slash command handler.
 *
 * Restores from the latest history snapshot (created by /compact).
 * Deletes the snapshot file after restore to prevent double-expand.
 * Returns __EXPAND__ signal with restored content for the orchestrator.
 *
 * Self-registers on module import.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FLOW_DIR_NAME } from "../../flow/scaffold.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleExpandSlash: SlashHandler = async (_args, ctx) => {
  const historyDir = path.join(ctx.cwd, FLOW_DIR_NAME, "history");

  // Read history directory
  let files: string[];
  try {
    files = await fs.readdir(historyDir);
  } catch {
    return "Nothing to expand. No compaction history found.";
  }

  // Filter to .md files and sort by name (ISO timestamp = chronological sort)
  const snapshots = files.filter((f) => f.endsWith(".md")).sort();

  if (snapshots.length === 0) {
    return "Nothing to expand. No compaction history found.";
  }

  // Read the latest snapshot
  const latestFile = snapshots[snapshots.length - 1];
  const latestPath = path.join(historyDir, latestFile);
  const content = await fs.readFile(latestPath, "utf8");

  // Delete the snapshot file (prevent double-expand per Pitfall 5)
  await fs.unlink(latestPath);

  // Count lines for summary
  const lines = content.split("\n").length;

  // Return signal for orchestrator to restore messages
  return `__EXPAND__\nRestored from ${latestFile} (${lines} lines). Previous compaction reversed.\n${content}`;
};

// Self-register on module import
registerSlash("expand", handleExpandSlash);
