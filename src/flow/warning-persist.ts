/**
 * Persists EE hook warnings into the active run's state.md.
 *
 * Fire-and-forget: errors are caught and logged, never thrown.
 * Cap: keeps the last MAX_STORED_WARNINGS unique warnings (deduplicated by
 * principle_uuid) to prevent unbounded context growth in state.md.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FLOW_DIR_NAME } from "./scaffold.js";
import { getActiveRunId, loadRun, updateRunFile } from "./run-manager.js";
import { getSection } from "./parser.js";
import { renderInterceptWarning } from "../ee/render.js";
import type { InterceptMatch } from "../ee/types.js";

const MAX_STORED_WARNINGS = 20;

/** Parse stored warning lines back to principle_uuid for dedup. */
function extractUuids(snapshot: string): string[] {
  const uuids: string[] = [];
  for (const line of snapshot.split("\n")) {
    // Warnings rendered with renderInterceptWarning contain principle_uuid implicitly
    // via the message. We tag each entry with UUID in the persisted format below.
    const m = line.match(/\[uuid:([^\]]+)\]/);
    if (m) uuids.push(m[1]);
  }
  return uuids;
}

function tagWarning(match: InterceptMatch, text: string): string {
  return `[uuid:${match.principle_uuid}] ${text}`;
}

/** Keep only the last MAX_STORED_WARNINGS unique-uuid entries. */
function trimSnapshot(snapshot: string, newUuid: string): string {
  // Split into per-warning blocks (each starts with a timestamp tag)
  const entries = snapshot.split(/(?=\[\d{4}-\d{2}-\d{2})/);
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const entry of entries.reverse()) { // newest first
    const m = entry.match(/\[uuid:([^\]]+)\]/);
    const uuid = m ? m[1] : entry.slice(0, 40); // fallback key
    if (!seen.has(uuid) && seen.size < MAX_STORED_WARNINGS - 1) {
      seen.add(uuid);
      kept.unshift(entry);
    }
  }

  return kept.filter(Boolean).join("").trim();
}

export async function persistWarning(cwd: string, match: InterceptMatch): Promise<void> {
  try {
    const flowDir = path.join(cwd, FLOW_DIR_NAME);
    try { await fs.access(flowDir); } catch { return; }

    const runId = await getActiveRunId(flowDir);
    if (!runId) return;

    const runState = await loadRun(flowDir, runId);
    if (!runState) return;

    const warningText = tagWarning(match, renderInterceptWarning(match));
    const timestampedWarning = `[${new Date().toISOString()}] ${warningText}`;

    const existing = getSection(runState.state, "Experience Snapshot") ?? "";

    // Deduplicate and cap
    const trimmed = trimSnapshot(existing, match.principle_uuid);
    const updated = trimmed ? `${trimmed}\n${timestampedWarning}` : timestampedWarning;

    runState.state.sections.set("Experience Snapshot", updated);
    await updateRunFile(flowDir, runId, "state.md", runState.state);
  } catch (err) {
    console.warn("[warning-persist] Failed to persist warning:", err);
  }
}
