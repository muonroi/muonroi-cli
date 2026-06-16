/**
 * src/ee/artifact-cache.ts
 *
 * In-process durable fallback for compaction-elided tool outputs (issue #3
 * increment 2 / anti-mù durability).
 *
 * When B3/B4 compaction rewrites a low-value tool result into a ~200-char stub,
 * the full content is shipped to the Experience Engine (source="tool-artifact")
 * so a later `ee_query("tool-artifact id=X")` can rehydrate it. But that recovery
 * depends on EE (Qdrant/HTTP) being reachable — if EE is down or timing out
 * mid-session (exactly when long sessions compact), the full content is lost to
 * the stub preview. This module keeps the elided full outputs in-process, keyed
 * by toolCallId, so rehydration works for THIS session regardless of EE. It is
 * the local-first leg of ee_query's tool-artifact lookup; EE remains the
 * cross-session / post-restart fallback.
 *
 * Bounded LRU so a long session can't grow it without limit. Survives the live
 * process, NOT a restart (that's EE's durable role).
 */

const DEFAULT_MAX_ENTRIES = 100;
/** Per-entry cap so one giant output can't dominate the LRU footprint. */
const MAX_CONTENT_CHARS = 200_000;

export interface ArtifactEntry {
  toolName: string;
  content: string;
}

const store = new Map<string, ArtifactEntry>();
let maxEntries = DEFAULT_MAX_ENTRIES;

/**
 * Record an elided tool output by its toolCallId. Re-recording the same id
 * refreshes its LRU position. No-ops on empty id/content.
 */
export function recordArtifact(toolCallId: string, toolName: string, content: string): void {
  if (!toolCallId || typeof content !== "string" || content.length === 0) return;
  if (store.has(toolCallId)) store.delete(toolCallId); // refresh recency
  store.set(toolCallId, { toolName: toolName || "", content: content.slice(0, MAX_CONTENT_CHARS) });
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Exact lookup by toolCallId. */
export function getArtifact(toolCallId: string): ArtifactEntry | null {
  if (!toolCallId) return null;
  return store.get(toolCallId) ?? null;
}

/**
 * Extract the id from a "tool-artifact id=<id>" / "full tool result id=<id>"
 * query (the exact strings the stub + contract tell the agent to use) and look
 * it up. Returns null when the query has no id= or the id is not cached.
 */
export function findArtifactByQuery(query: string): (ArtifactEntry & { toolCallId: string }) | null {
  const m = /\bid\s*=\s*["']?([A-Za-z0-9_\-:.]+)/i.exec(query || "");
  if (!m) return null;
  const id = m[1]!;
  const hit = store.get(id);
  return hit ? { toolCallId: id, toolName: hit.toolName, content: hit.content } : null;
}

// ─── Test hooks ──────────────────────────────────────────────────────────────
export function __resetArtifactCacheForTests(): void {
  store.clear();
  maxEntries = DEFAULT_MAX_ENTRIES;
}
export function __setArtifactCacheMaxForTests(n: number): void {
  maxEntries = Math.max(1, n);
}
export function __artifactCacheSize(): number {
  return store.size;
}
