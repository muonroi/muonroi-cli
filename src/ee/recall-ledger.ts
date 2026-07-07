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
  /** Check if an id was ever cleared (fed back) in this session. Used by PIL Layer 3 to suppress re-injection. */
  wasCleared(id: string): boolean;
  /**
   * Check if an id is currently PENDING (recorded as unrated debt, not yet fed
   * back). PIL Layer 3 uses this to suppress re-injecting the FULL content of a
   * hint it already surfaced earlier this session — the hit is already in the
   * conversation history and still listed in the feedback nudge, so repeating
   * its body every turn is pure token waste (the "hint lặp" repetition). First
   * sighting is injected + recorded; subsequent turns skip the body.
   */
  isPending(id: string): boolean;
  /** Oldest-first list of still-unrated recalls. */
  pending(): PendingRecall[];
  pendingCount(): number;
  reset(): void;
}

export function createRecallLedger(): RecallLedger {
  const map = new Map<string, PendingRecall>();
  // Tracks ids that have been fed back, so PIL Layer 3 can suppress re-injection.
  const cleared = new Set<string>();
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
      const nid = String(id ?? "").trim();
      const deleted = map.delete(nid);
      if (deleted) cleared.add(nid);
      return deleted;
    },
    wasCleared(id) {
      return cleared.has(String(id ?? "").trim());
    },
    isPending(id) {
      return map.has(String(id ?? "").trim());
    },
    pending() {
      return [...map.values()].sort((a, b) => a.ts - b.ts);
    },
    pendingCount() {
      return map.size;
    },
    reset() {
      map.clear();
      cleared.clear();
    },
  };
}

/** Process-scoped singleton = the current MCP session's unrated-recall debt. */
export const sessionRecallLedger: RecallLedger = createRecallLedger();

/**
 * Whether the recall-feedback ledger is active. Mirrors the gate env the external
 * MCP ee.query already honours (EXPERIENCE_RECALL_FEEDBACK_GATE) so an operator
 * can disable in-CLI ledger accounting with the same switch. In-CLI we only need
 * on/off — never a hard refusal — so a turn is never blocked. Default on (soft).
 */
export function isRecallLedgerEnabled(): boolean {
  return (
    String(process.env.EXPERIENCE_RECALL_FEEDBACK_GATE ?? "soft")
      .trim()
      .toLowerCase() !== "off"
  );
}

/**
 * Compact, token-bounded reminder of still-unrated surfaced/recalled handles, for
 * injection next to the `[id]` handles the agent already saw. Names the actual
 * `{id, collection}` pairs so an `ee_feedback(id, collection, verdict)` call is
 * actionable — the legacy static nudge named no ids, so the model could not
 * complete the rating even when willing. Capped so a long session can't bloat the
 * prompt (token-thrift).
 */
export function formatPendingReminder(pending: PendingRecall[], opts: { max?: number } = {}): string {
  if (pending.length === 0) return "";
  const max = Math.max(1, Math.min(opts.max ?? 5, 20));
  const shown = pending.slice(0, max);
  const lines = shown.map((p) => `  - [${p.id} ${p.collection ?? "?"}]`);
  const more = pending.length > max ? `\n  …and ${pending.length - max} more` : "";
  return (
    `↳ ${pending.length} earlier EE hint(s) still unrated — rate the one(s) you acted on so the brain keeps what helped: ` +
    `ee_feedback(id, collection, followed|ignored|noise).\n${lines.join("\n")}${more}`
  );
}
