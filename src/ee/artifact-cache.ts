/**
 * src/ee/artifact-cache.ts
 *
 * Durable fallback for compaction-elided tool outputs (issue #3 increment 2 /
 * anti-mù durability).
 *
 * When B3/B4 compaction rewrites a low-value tool result into a ~200-char stub,
 * the full content is shipped to the Experience Engine (source="tool-artifact")
 * so a later `ee_query("tool-artifact id=X")` can rehydrate it. But that recovery
 * depends on EE (Qdrant/HTTP) being reachable. This module is the EE-independent
 * recovery path, in two tiers:
 *   - in-process LRU (keyed by toolCallId): authoritative full content for THIS
 *     session, instant, survives an EE outage mid-session;
 *   - append-only disk spill (~/.muonroi-cli/artifact-cache.jsonl): survives a
 *     PROCESS RESTART too, so a restart + EE-down double-failure can still
 *     rehydrate. Disable with MUONROI_ARTIFACT_CACHE_DISK=0.
 *
 * ee_query reads in-memory first, then disk, then falls back to EE /api/search
 * (the cross-session source). Both tiers are bounded; both are best-effort and
 * fail-open (a disk error never breaks recall).
 */

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 100;
/** Per-entry cap so one giant output can't dominate the footprint. */
const MAX_CONTENT_CHARS = 200_000;
/** Disk-file size cap; on overflow the file is reset (EE retains older artifacts). */
const DISK_MAX_BYTES = 8 * 1024 * 1024;

export interface ArtifactEntry {
  toolName: string;
  content: string;
}

const store = new Map<string, ArtifactEntry>();
let maxEntries = DEFAULT_MAX_ENTRIES;
let diskPathOverride: string | null = null;
const pendingWrites = new Set<Promise<void>>();

function diskEnabled(): boolean {
  return process.env.MUONROI_ARTIFACT_CACHE_DISK !== "0";
}
function diskPath(): string {
  return diskPathOverride ?? path.join(os.homedir(), ".muonroi-cli", "artifact-cache.jsonl");
}

/** Extract the id from a "tool-artifact id=<id>" / "full tool result id=<id>" query. */
function extractArtifactId(query: string): string | null {
  const m = /\bid\s*=\s*["']?([A-Za-z0-9_\-:.]+)/i.exec(query || "");
  return m ? m[1]! : null;
}

/**
 * Record an elided tool output by toolCallId. In-memory set is synchronous;
 * the disk append is fire-and-forget (tracked so tests can flush it). No-ops on
 * empty id/content.
 */
export function recordArtifact(toolCallId: string, toolName: string, content: string): void {
  if (!toolCallId || typeof content !== "string" || content.length === 0) return;
  const capped = content.slice(0, MAX_CONTENT_CHARS);
  if (store.has(toolCallId)) store.delete(toolCallId); // refresh recency
  store.set(toolCallId, { toolName: toolName || "", content: capped });
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  if (diskEnabled()) {
    const w = appendArtifactToDisk(toolCallId, toolName || "", capped).catch((err) => {
      console.error(`[artifact-cache] disk append failed: ${(err as Error)?.message}`);
    });
    pendingWrites.add(w);
    void w.finally(() => pendingWrites.delete(w));
  }
}

/** The actual disk append (awaitable). Resets the file when it exceeds the size cap. */
export async function appendArtifactToDisk(toolCallId: string, toolName: string, content: string): Promise<void> {
  const p = diskPath();
  await mkdir(path.dirname(p), { recursive: true });
  try {
    const s = await stat(p);
    if (s.size > DISK_MAX_BYTES) await writeFile(p, "");
  } catch {
    /* file does not exist yet — nothing to cap */
  }
  await appendFile(p, `${JSON.stringify({ id: toolCallId, toolName, content })}\n`);
}

/** Exact in-memory lookup by toolCallId. */
export function getArtifact(toolCallId: string): ArtifactEntry | null {
  if (!toolCallId) return null;
  return store.get(toolCallId) ?? null;
}

/**
 * Synchronous in-memory lookup from a contract query string. Returns null when
 * the query has no id= or the id is not in the in-process LRU.
 */
export function findArtifactByQuery(query: string): (ArtifactEntry & { toolCallId: string }) | null {
  const id = extractArtifactId(query);
  if (!id) return null;
  const hit = store.get(id);
  return hit ? { toolCallId: id, toolName: hit.toolName, content: hit.content } : null;
}

/**
 * Disk-tier lookup (survives restart). Scans the spill file newest-first so the
 * most recent record for an id wins. Fail-open: a missing/corrupt file yields
 * null, never throws.
 */
export async function findArtifactOnDisk(query: string): Promise<(ArtifactEntry & { toolCallId: string }) | null> {
  if (!diskEnabled()) return null;
  const id = extractArtifactId(query);
  if (!id) return null;
  let text: string;
  try {
    text = await readFile(diskPath(), "utf8");
  } catch {
    return null; // no spill file yet
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { id?: string; toolName?: string; content?: string };
      if (row.id === id) return { toolCallId: id, toolName: row.toolName ?? "", content: row.content ?? "" };
    } catch {
      /* skip a torn/partial append line */
    }
  }
  return null;
}

// ─── Test hooks ──────────────────────────────────────────────────────────────
export function __resetArtifactCacheForTests(): void {
  store.clear();
  maxEntries = DEFAULT_MAX_ENTRIES;
  diskPathOverride = null;
}
export function __setArtifactCacheMaxForTests(n: number): void {
  maxEntries = Math.max(1, n);
}
export function __setArtifactCacheDiskPathForTests(p: string | null): void {
  diskPathOverride = p;
}
export function __artifactCacheSize(): number {
  return store.size;
}
/** Await all in-flight fire-and-forget disk writes (deterministic tests). */
export async function flushArtifactDiskWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}
