/**
 * event-tee.ts — optional JSONL sink for harness LiveEvents.
 *
 * Why: the MCP wake mechanism that re-invokes an external agent is a background
 * task (e.g. a milestone watcher), which is a SEPARATE process from the MCP
 * server. That watcher can only read files — it cannot reach the in-process
 * driver that holds the real UI. So a generic, reusable milestone watcher needs
 * the harness to persist events to a file it can tail.
 *
 * The DB only records debate-END rows (synthesis/debate_complete), so a
 * DB-poll watcher is blind to mid-flight modal pauses (askcard-open) that never
 * write a DB row. Teeing every LiveEvent to a JSONL file closes that gap for
 * ANY event kind.
 *
 * Ephemeral events (toast, disconnect, retry, ee-*) flash and vanish before an
 * agent can wake + render, so for those kinds — and ONLY those — we attach a
 * plain-text visual snapshot captured at emit time, so the watcher's wake
 * payload carries the exact frame. Persistent states (askcard, post-debate
 * card) stay put, so the agent renders them fresh on demand; embedding a stale
 * snapshot for those would be worse, not better.
 *
 * Gated entirely behind MUONROI_HARNESS_EVENT_LOG — unset means zero behavior
 * change (clean checkouts are byte-identical to before this file existed).
 */

import { appendFileSync } from "node:fs";
import type { LiveEvent } from "./protocol.js";

/**
 * Event kinds that flash and disappear before an agent can wake + render.
 * Only these carry an at-emit visual snapshot in the teed line.
 */
export const EPHEMERAL_KINDS: ReadonlySet<string> = new Set<string>([
  "toast",
  "disconnect",
  "stream-retry",
  "ee-timeout",
  "ee-error",
  "grounding-flag",
]);

/** One teed JSONL record. */
export interface TeedEventLine {
  ts: number;
  kind: string;
  event: LiveEvent;
  /** Present only for EPHEMERAL_KINDS — plain-text visual frame at emit time. */
  visualText?: string;
}

/**
 * Build an event-tee sink. Returns null when MUONROI_HARNESS_EVENT_LOG is unset
 * or blank (no-op path — caller skips it entirely).
 *
 * @param getVisualText - lazily renders the current visual frame to plain text
 *   (driver.render_visual). Called ONLY for ephemeral kinds, so persistent
 *   events pay nothing.
 * @param envValue - value of MUONROI_HARNESS_EVENT_LOG (injectable for tests).
 */
export function createEventTee(
  getVisualText: () => string | null,
  envValue?: string,
): ((event: LiveEvent) => void) | null {
  const path = (envValue ?? "").trim();
  if (!path) return null;

  return (event: LiveEvent): void => {
    // The idle sentinel arrives as { t: "idle" } — never here. Guard anyway so
    // a malformed event can't crash the ingest loop.
    const kind = (event as { kind?: string }).kind;
    if (typeof kind !== "string") return;

    const line: TeedEventLine = { ts: Date.now(), kind, event };

    if (EPHEMERAL_KINDS.has(kind)) {
      try {
        const visual = getVisualText();
        if (visual) line.visualText = visual;
      } catch (err) {
        // A visual-render failure must not drop the event record itself.
        console.error(`[event-tee] visual snapshot failed for kind=${kind}: ${(err as Error)?.message}`);
      }
    }

    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`);
    } catch (err) {
      console.error(`[event-tee] append failed (path=${path}, kind=${kind}): ${(err as Error)?.message}`);
    }
  };
}
