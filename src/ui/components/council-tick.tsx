import { useEffect, useState } from "react";
import { heartbeatDebug } from "../heartbeat-debug.js";

/**
 * `council-tick` — the two timers the council surface needs to look alive.
 *
 * Both already existed as private copies inside council-debate-pill.tsx and
 * council-phase-timeline.tsx. This is the shared home so the scoreboard rail
 * does not become a third copy; the existing two keep their local versions for
 * now (each is wired to its own named `heartbeatDebug` probe, and swapping them
 * would change what the freeze diagnostics report).
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner, 100ms per frame. Renders as a bare glyph — no wrapper. */
export function CouncilSpinner({ probe = "council-spinner" }: { probe?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      heartbeatDebug(probe, "timer");
      setFrame((n) => (n + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(id);
  }, [probe]);
  return <>{SPINNER_FRAMES[frame]}</>;
}

/**
 * Re-render the consumer every `tickMs` and hand back the current epoch time,
 * so an elapsed counter derived from a `startedAt` stamp keeps moving.
 *
 * Without this the display freezes at whatever `elapsedMs` the emitter last
 * sent — and the emitter only sends on state transitions, which is exactly the
 * "im lìm" (dead-looking) symptom a live council run must not have.
 */
export function useCouncilHeartbeat(tickMs = 1000, probe = "council-heartbeat"): number {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      heartbeatDebug(probe, "timer");
      force((n) => n + 1);
    }, tickMs);
    return () => clearInterval(id);
  }, [tickMs, probe]);
  return Date.now();
}

/** `38s` / `4m12s` — the compact elapsed form used across the council surface. */
export function formatCouncilElapsed(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
