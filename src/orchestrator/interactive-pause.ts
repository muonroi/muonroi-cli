/**
 * src/orchestrator/interactive-pause.ts
 *
 * Process-global "an interactive card is blocking the turn" gate.
 *
 * Some tools (`ask_user`) block inside their AI-SDK `execute()` waiting for a
 * human to answer a card. During that wait NO stream chunks flow, so both the
 * per-attempt stall watchdog (getProviderStallTimeoutMs, default 2 min) and the
 * turn-idle watchdog (MUONROI_TURN_IDLE_MS, default 2 min) would fire and abort
 * a turn that is not stalled at all — the human is just thinking.
 *
 * Rather than thread a keepalive timer through every call site, the blocking
 * handler brackets its wait with {@link beginInteractivePause} /
 * {@link endInteractivePause}, and both watchdogs consult
 * {@link isInteractivePaused} before firing — re-arming instead of aborting
 * while a card is open. Counter (not boolean) so nested/concurrent cards are
 * safe.
 */

let pauseDepth = 0;

/** Enter an interactive pause — call before awaiting a blocking card. */
export function beginInteractivePause(): void {
  pauseDepth += 1;
}

/** Leave an interactive pause — call in a `finally` after the card resolves. */
export function endInteractivePause(): void {
  pauseDepth = Math.max(0, pauseDepth - 1);
}

/** True while at least one interactive card is blocking the turn. */
export function isInteractivePaused(): boolean {
  return pauseDepth > 0;
}

/** Test-only: force the counter back to zero. */
export function __resetInteractivePauseForTests(): void {
  pauseDepth = 0;
}
