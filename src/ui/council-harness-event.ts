/**
 * src/ui/council-harness-event.ts
 *
 * Pure mapping from a council `CouncilStatusData` chunk to the harness
 * `council-speaker` LiveEvent payload.
 *
 * Why this exists. The long research phase (`llm.research`, up to ~10 min /
 * 15 tool steps) runs as a single internal `generateText` — the MAIN stream is
 * quiet the whole time, so `tui_wait_for(idle)` reports a FALSE idle and an
 * agent driving the TUI misjudges the run as hung. The only signal during that
 * window is the 1s `council_status` heartbeat (`state:"tick"`, advancing
 * `elapsedMs`) emitted by `tracedAsync`. Previously the emit site collapsed
 * every non-start state to `status:"done"` and DROPPED `elapsedMs`, so a poller
 * reading `tui_last_event("council-speaker")` saw a frozen "done" event and
 * concluded the speaker had finished — the exact false-stall this fixes.
 *
 * Carrying `state:"tick"` + `elapsedMs` through lets a harness monitor
 * distinguish ALIVE (elapsedMs advancing across polls) from HUNG (elapsedMs
 * frozen past a threshold) with a single `tui_last_event` call.
 */

import type { CouncilStatusState } from "../types/index.js";

/** Harness `council-speaker` status: adds "tick" progress heartbeat to start/done. */
export type CouncilSpeakerStatus = "start" | "tick" | "done";

export interface CouncilStatusLike {
  state: CouncilStatusState;
  statusId: string;
  role?: string;
  label?: string;
  elapsedMs?: number;
  streamedChars?: number;
  lastDeltaAgeMs?: number;
}

export interface CouncilSpeakerEvent {
  t: "event";
  kind: "council-speaker";
  role: string;
  status: CouncilSpeakerStatus;
  correlationId: string;
  elapsedMs?: number;
  /** Chars (text + reasoning deltas) streamed since this phase began. */
  streamedChars?: number;
  /** Age of the most recent stream delta, in ms. */
  lastDeltaAgeMs?: number;
}

/**
 * Map a council status chunk to the `council-speaker` harness event payload.
 * `start`→"start", `tick`→"tick" (progress heartbeat), `done`/`error`→"done".
 * `elapsedMs` is passed through unchanged so a poller can measure progress.
 *
 * `streamedChars` / `lastDeltaAgeMs` ride along when the council emitted them.
 * `elapsedMs` can freeze even on a healthy call — the tick generator only
 * advances when its consumer pulls, and a round awaiting pairs via Promise.all
 * does not pull. These two are pushed from the token stream itself, so they
 * separate SLOW-BUT-ALIVE (chars growing, small delta age) from STUCK (chars
 * static, delta age growing) without depending on generator pumping.
 */
export function mapCouncilStatusToSpeakerEvent(cs: CouncilStatusLike): CouncilSpeakerEvent {
  const status: CouncilSpeakerStatus = cs.state === "start" ? "start" : cs.state === "tick" ? "tick" : "done";
  return {
    t: "event",
    kind: "council-speaker",
    role: cs.role ?? cs.label ?? "unknown",
    status,
    correlationId: cs.statusId,
    ...(typeof cs.elapsedMs === "number" ? { elapsedMs: cs.elapsedMs } : {}),
    ...(typeof cs.streamedChars === "number" ? { streamedChars: cs.streamedChars } : {}),
    ...(typeof cs.lastDeltaAgeMs === "number" ? { lastDeltaAgeMs: cs.lastDeltaAgeMs } : {}),
  };
}
