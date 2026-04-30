/**
 * Persists EE hook warnings into the active run's state.md.
 *
 * Called from the PreToolUse hook path AFTER the warning is rendered to
 * the TUI. Fire-and-forget: errors are caught and logged, never thrown.
 *
 * Each warning is timestamped and appended to the "Experience Snapshot"
 * section so compaction never erases them and they survive kill-restart.
 *
 * TODO: Wire into ee/hooks.ts after emitMatches() call
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FLOW_DIR_NAME } from "./scaffold.js";
import { getActiveRunId, loadRun, updateRunFile } from "./run-manager.js";
import { getSection } from "./parser.js";
import { renderInterceptWarning } from "../ee/render.js";
import type { InterceptMatch } from "../ee/types.js";

/**
 * Append an EE warning to the active run's state.md Experience Snapshot.
 *
 * No-op (does not throw) when:
 * - .muonroi-flow/ does not exist
 * - No active run is set
 * - Active run cannot be loaded
 */
export async function persistWarning(cwd: string, match: InterceptMatch): Promise<void> {
  try {
    const flowDir = path.join(cwd, FLOW_DIR_NAME);

    // Check for .muonroi-flow/ directory
    try {
      await fs.access(flowDir);
    } catch {
      return; // No flow dir — no-op
    }

    // Get active run ID
    const runId = await getActiveRunId(flowDir);
    if (!runId) return;

    // Load run state
    const runState = await loadRun(flowDir, runId);
    if (!runState) return;

    // Format warning text
    const warningText = renderInterceptWarning(match);
    const timestampedWarning = `[${new Date().toISOString()}] ${warningText}`;

    // Read existing Experience Snapshot and append
    const existing = getSection(runState.state, "Experience Snapshot") ?? "";
    const updated = existing
      ? `${existing}\n${timestampedWarning}`
      : timestampedWarning;

    // Write back
    runState.state.sections.set("Experience Snapshot", updated);
    await updateRunFile(flowDir, runId, "state.md", runState.state);
  } catch (err) {
    // Fire-and-forget: log but never throw
    console.warn("[warning-persist] Failed to persist warning:", err);
  }
}
