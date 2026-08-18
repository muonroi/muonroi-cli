// ---------------------------------------------------------------------------
// Needs-key bus — carries "enabled but keyless" MCP servers from the turn
// pipeline (tool-engine's McpToolBundle.needsKey) to the TUI's inline fix card.
// ---------------------------------------------------------------------------
// The orchestrator and the TUI live in the same process but have no direct
// channel for this signal: the bundle is consumed deep inside tool-engine while
// the card lives in React state. This tiny pub/sub decouples them without
// threading a callback through the whole turn pipeline.
//
// Per-process, per-server once semantics mirror noticeNeedsKeyOnce (the console
// twin in key-requirements.ts) but are tracked SEPARATELY: the console notice
// may fire during warmup before React has mounted, and the card must not be
// lost because of that ordering — publishes with no subscriber are buffered and
// replayed to the first subscriber.
// ---------------------------------------------------------------------------

import type { MissingKeyServer } from "./key-requirements.js";

type NeedsKeyListener = (servers: MissingKeyServer[]) => void;

const listeners = new Set<NeedsKeyListener>();
/** Server ids already announced to the UI this process (once per session). */
const announced = new Set<string>();
/** Publishes that arrived before any subscriber mounted. */
let pending: MissingKeyServer[] = [];

/**
 * Announce enabled-but-keyless servers to the UI. Each server id is announced
 * at most once per process; repeat publishes (every turn re-reports the same
 * `needsKey` list) are no-ops. Buffered when no subscriber is mounted yet.
 */
export function publishNeedsKey(servers: MissingKeyServer[]): void {
  const fresh = servers.filter((s) => !announced.has(s.id));
  if (fresh.length === 0) return;
  for (const s of fresh) announced.add(s.id);
  if (listeners.size === 0) {
    pending.push(...fresh);
    return;
  }
  for (const listener of listeners) listener(fresh);
}

/**
 * Subscribe to needs-key announcements. Any buffered pre-mount announcements
 * are delivered synchronously to the first subscriber. Returns an unsubscribe.
 */
export function subscribeNeedsKey(listener: NeedsKeyListener): () => void {
  listeners.add(listener);
  if (pending.length > 0) {
    const buffered = pending;
    pending = [];
    listener(buffered);
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget that a server (or all servers) was announced, so a future turn can
 * re-surface the card — e.g. after the user stored a key that later turns out
 * to be revoked. Tests use the no-arg form between cases.
 */
export function resetNeedsKeyAnnouncements(id?: string): void {
  if (id) {
    announced.delete(id);
    pending = pending.filter((s) => s.id !== id);
    return;
  }
  announced.clear();
  pending = [];
}
