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
 * ON BY DEFAULT (see {@link resolveEventLogPath}): an opt-in sink is one nobody
 * remembers to opt into, and the cost of the log missing is an agent that
 * cannot tell "waiting for a human" from "hung" — the exact confusion this file
 * exists to prevent. Set MUONROI_HARNESS_EVENT_LOG=0 (or "off"/"false") to
 * disable, or to a path to choose your own.
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Values that turn the sink off. Anything else is treated as a path. */
const DISABLE_VALUES: ReadonlySet<string> = new Set(["0", "off", "false", "no"]);

/**
 * Resolve where events are teed, from the MUONROI_HARNESS_EVENT_LOG value.
 *
 * - unset/blank → a per-pid file in the OS temp dir (the default-on path)
 * - "0" / "off" / "false" / "no" → null, sink disabled
 * - anything else → that literal path
 *
 * Per-pid keeps concurrent harness servers from interleaving into one file, and
 * puts the log where the OS already reclaims it — no rotation to maintain.
 *
 * @param pid - process id (injectable for tests).
 */
export function resolveEventLogPath(envValue?: string, pid: number = process.pid): string | null {
  const raw = (envValue ?? "").trim();
  if (DISABLE_VALUES.has(raw.toLowerCase())) return null;
  if (raw) return raw;
  return join(tmpdir(), `muonroi-harness-events-${pid}.jsonl`);
}

/**
 * Build an event-tee sink. Returns null only when the sink is explicitly
 * disabled — see {@link resolveEventLogPath}.
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
  const path = resolveEventLogPath(envValue);
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
