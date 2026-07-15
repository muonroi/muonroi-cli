/**
 * src/ui/heartbeat-debug.ts
 *
 * Env-gated instrumentation to pinpoint the council rail "frozen elapsed / static
 * spinner" during long phases. Live evidence (harness 60Hz dedup frames identical
 * for 110s + braille spinner not rotating) shows a real in-phase render/paint
 * freeze, but NOT which link starves: (T) the setInterval TIMER not firing, (R)
 * the timer fires but React does not re-render/commit, or (P) React commits but
 * OpenTUI does not repaint.
 *
 * When `MUONROI_HEARTBEAT_DEBUG` is set to a file path, we append one JSONL line
 * per event so a single instrumented council run answers T/R/P:
 *   - kind:"timer"  → a setInterval callback actually fired  (rules in/out T)
 *   - kind:"render" → a component's render body ran           (rules in/out R)
 * Compare timestamps against the sidechannel council-step timeline: if `timer`
 * lines keep landing every ~100/1000ms through a phase but the harness frame is
 * frozen, the starve is at paint (P); if `timer` lines STOP during the phase, the
 * event loop / timer is starved (T).
 *
 * Unset → a single boolean check per call, zero file I/O, zero behaviour change.
 */

import { appendFileSync } from "node:fs";

const SINK = process.env.MUONROI_HEARTBEAT_DEBUG?.trim() || null;

export function heartbeatDebugEnabled(): boolean {
  return SINK !== null;
}

/**
 * Append one instrumentation record. No-op unless MUONROI_HEARTBEAT_DEBUG points
 * at a file. `kind` is "timer" (a setInterval callback fired) or "render" (a
 * component render body executed). `extra` carries component-specific detail
 * (frame index, computed elapsedMs, phase label).
 */
export function heartbeatDebug(component: string, kind: "timer" | "render", extra?: Record<string, unknown>): void {
  if (SINK === null) return;
  try {
    const rec = { ts: Date.now(), component, kind, ...(extra ?? {}) };
    appendFileSync(SINK, `${JSON.stringify(rec)}\n`);
  } catch (err) {
    // Instrumentation must never break the UI; surface once at debug level.
    console.error(`[heartbeat-debug] append failed: ${(err as Error)?.message}`);
  }
}
