/**
 * src/product-loop/backlog-store.ts
 *
 * Atomic read/write helpers for .planning/runs/<runId>/backlog.json.
 * Uses atomicWriteJSON / atomicReadJSON from storage/atomic-io.ts —
 * temp-rename pattern ensures no half-written state on crash/Ctrl+C.
 */

import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "../storage/atomic-io.js";
import type { Backlog, BacklogItem } from "./types.js";

function backlogPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "backlog.json");
}

/**
 * Read backlog.json for a run. Returns null when the file does not exist.
 */
export async function readBacklog(flowDir: string, runId: string): Promise<Backlog | null> {
  return atomicReadJSON<Backlog>(backlogPath(flowDir, runId));
}

/**
 * Write (overwrite) backlog.json atomically.
 */
export async function writeBacklog(flowDir: string, runId: string, backlog: Backlog): Promise<void> {
  await atomicWriteJSON(backlogPath(flowDir, runId), backlog);
}

/**
 * Patch a single BacklogItem inside an existing backlog.json.
 * Always updates updatedAtUtc on the patched item.
 * Throws when backlog.json is missing or the itemId is not found.
 */
export async function updateBacklogItem(
  flowDir: string,
  runId: string,
  itemId: string,
  patch: Partial<BacklogItem>,
): Promise<Backlog> {
  const backlog = await readBacklog(flowDir, runId);
  if (!backlog) {
    throw new Error(`updateBacklogItem: backlog.json not found for runId=${runId}`);
  }

  const idx = backlog.items.findIndex((i) => i.id === itemId);
  if (idx === -1) {
    throw new Error(`updateBacklogItem: item id=${itemId} not found in backlog for runId=${runId}`);
  }

  const now = new Date().toISOString();
  backlog.items[idx] = {
    ...backlog.items[idx],
    ...patch,
    // Always refresh updatedAtUtc regardless of whether the patch includes it.
    updatedAtUtc: now,
  };

  await writeBacklog(flowDir, runId, backlog);
  return backlog;
}
