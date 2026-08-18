/**
 * src/orchestrator/turn-progress.ts
 *
 * "Something real just happened" ping for the top-level turn watchdog.
 *
 * `turn-watchdog.ts` resets its idle timer only on YIELDED chunks, and nothing is
 * yielded before `streamText` — so the single 120s budget covers the whole
 * pre-stream phase (MCP acquire, system-prompt build), every retry backoff, AND
 * the model's time-to-first-byte, all at once. Providers that are merely SLOW to
 * first byte therefore look identical to providers that are hung.
 *
 * Session 1096fc59144c hit both halves on z.ai/glm-4.7: turn 2 spent two
 * `Internal network failure` error-part retries at ~35-45s each and the watchdog
 * fired while the third attempt was still in flight; turn 3 spent 97s in
 * pre-stream setup and was killed 15s into a stream that had not yet returned a
 * byte (the Z.ai coding endpoint force-enables thinking, TTFT 10.6-11.4s).
 *
 * A ping means "a request was just issued to the provider". The watchdog treats
 * it as grounds to RE-ARM rather than fire, so each attempt gets a full idle
 * window instead of sharing one with the setup phase. It is deliberately NOT a
 * suppression: re-arming requires a NEW ping in each window, so a genuinely
 * wedged setup phase (no ping at all) still fires — which is what should surface
 * a slow `acquireMcpTools` instead of hiding it behind a bigger budget.
 *
 * Distinct from `tool-activity.ts`, which answers "is a tool still inside its own
 * declared deadline" — that one suppresses, this one re-arms.
 */

/** Wall-clock instant of the most recent ping. 0 = never pinged. */
let lastPingMs = 0;

/** Record forward progress: a request to the provider was just issued. */
export function pingTurnProgress(now = Date.now()): void {
  lastPingMs = now;
}

/**
 * True when a ping landed strictly after `sinceMs` — i.e. the turn made real
 * progress during the window that just elapsed, so the idle timer should re-arm
 * instead of declaring the turn hung.
 */
export function hasTurnProgressSince(sinceMs: number): boolean {
  return lastPingMs > sinceMs;
}

/** Test-only: forget every ping. */
export function __resetTurnProgressForTests(): void {
  lastPingMs = 0;
}
