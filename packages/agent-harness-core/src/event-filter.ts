/**
 * event-filter.ts — MUONROI_HARNESS_EVENTS allowlist filter.
 *
 * Controls which event kinds are allowed to be emitted on the sidechannel.
 *
 * Env var: MUONROI_HARNESS_EVENTS
 *   Unset → lifecycle preset (all except llm-token)
 *   "all" or "*" → every kind
 *   "lifecycle" → the lifecycle preset group
 *   Comma-separated kinds → exact allowlist (e.g. "toast,council-step")
 *
 * Lifecycle preset covers all lifecycle/structural events but intentionally
 * excludes "llm-token" (80–120 events/sec at peak — must be opt-in).
 */

import type { LiveEvent } from "./protocol.js";

/** All non-idle event kinds defined in protocol.ts. */
export type EventKind = Extract<LiveEvent, { t: "event" }>["kind"];

/**
 * The lifecycle preset: everything except the high-volume token stream.
 * Default when MUONROI_HARNESS_EVENTS is unset.
 */
export const LIFECYCLE_PRESET: ReadonlySet<EventKind> = new Set<EventKind>([
  "toast",
  "stream.delta",
  "llm-done",
  "council-step",
  "council-speaker",
  "council-turn-length",
  "askcard-open",
  "askcard-answered",
  "askcard-cancel",
  "sprint-stage",
  "sprint-halt",
  // Emitted at product-loop/index.ts on plan commit; a wake-at-milestone monitor
  // must see it. Was previously dropped by this preset despite being emitted.
  "sprint-plan-committed",
  "route-decision",
  "steer-inject",
  // A driving agent MUST see this to react to an in-TUI /resume under the
  // harness (stop → start --session). Dropping it would silently swallow the
  // only signal that a relaunch was suppressed.
  "resume-request",
  "usage",
  // Ephemeral kinds carry a visualText snapshot for wake-at-milestone monitors
  // (event-tee.ts EPHEMERAL_KINDS). The default preset must not drop them, or a
  // monitor on MUONROI_HARNESS_EVENT_LOG misses errors/timeouts/disconnects.
  "ee-timeout",
  "ee-error",
  "grounding-flag",
  "stream-retry",
  "disconnect",
]);

/**
 * Returns a predicate that returns true when an event kind is allowed to emit.
 *
 * @param envValue - The value of MUONROI_HARNESS_EVENTS env var (may be undefined).
 *
 * Usage:
 *   const filter = createEventFilter(process.env["MUONROI_HARNESS_EVENTS"]);
 *   if (!filter(event.kind)) return; // drop
 */
export function createEventFilter(envValue?: string): (kind: string) => boolean {
  // Unset → lifecycle preset (llm-token off)
  if (envValue === undefined || envValue === "") {
    return (kind: string) => LIFECYCLE_PRESET.has(kind as EventKind);
  }

  const trimmed = envValue.trim();

  // Wildcard: allow everything
  if (trimmed === "*" || trimmed === "all") {
    return () => true;
  }

  // "lifecycle" named preset
  if (trimmed === "lifecycle") {
    return (kind: string) => LIFECYCLE_PRESET.has(kind as EventKind);
  }

  // Comma-separated list of exact kind names
  const allowed = new Set(
    trimmed
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  // If the list contains "lifecycle", expand it to all preset members
  if (allowed.has("lifecycle")) {
    allowed.delete("lifecycle");
    for (const k of LIFECYCLE_PRESET) {
      allowed.add(k);
    }
  }

  return (kind: string) => allowed.has(kind);
}
