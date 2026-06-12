/**
 * src/ee/recall-ledger.ts
 *
 * In-memory, session-scoped ledger of recalled `[id col]` handles that have NOT
 * yet been rated via the ee_feedback MCP tool. The muonroi-tools MCP server is one
 * process per agent session, so a module-level singleton IS the session: every
 * ee_query adds its returned entries as PENDING debt; every ee_feedback clears one;
 * ee_query then surfaces (soft mode) or refuses on (hard mode) accumulated unrated
 * debt. This is what forces a verdict on useful recalls — the only signal that lets
 * the brain keep the good entries and prune the rest, because recall surfaces are
 * deliberately excluded from the implicit-precision reconcile path.
 */

import type { EERecallEntry } from "./types.js";

export interface PendingRecall {
  id: string;
  collection: string | null;
  query: string;
  ts: number;
}

export interface RecallLedger {
  /** Stamp the entries returned by a recall as pending debt (first sighting wins). */
  record(entries: EERecallEntry[] | undefined, query: string): void;
  /** Clear one id once it has been rated. Returns true if it was actually pending. */
  clear(id: string): boolean;
  /** Oldest-first list of still-unrated recalls. */
  pending(): PendingRecall[];
  pendingCount(): number;
  reset(): void;
}

export function createRecallLedger(): RecallLedger {
  const map = new Map<string, PendingRecall>();
  return {
    record(entries, query) {
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const e of entries) {
        const id = e && e.id != null ? String(e.id).trim() : "";
        if (!id) continue;
        // First sighting keeps the original ts + query so age-based reporting is
        // honest; re-recalling an already-pending id must not reset its clock.
        if (!map.has(id)) {
          map.set(id, {
            id,
            collection: e.collection ?? null,
            query: String(query || "").slice(0, 120),
            ts: now,
          });
        }
      }
    },
    clear(id) {
      return map.delete(String(id ?? "").trim());
    },
    pending() {
      return [...map.values()].sort((a, b) => a.ts - b.ts);
    },
    pendingCount() {
      return map.size;
    },
    reset() {
      map.clear();
    },
  };
}

/** Process-scoped singleton = the current MCP session's unrated-recall debt. */
export const sessionRecallLedger: RecallLedger = createRecallLedger();
