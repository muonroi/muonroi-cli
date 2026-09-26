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
 *
 * Round 5 (G8 HIGH #1): a single ping before a pre-stream phase only buys ONE
 * extra idle window — a phase slower than `idleMs` (compaction's proposer, a
 * hook, a PIL classifier, the GSD gate's leader-tier assessor, the G9
 * relatedness classifier) still starves the watchdog exactly like before.
 * `startPeriodicTurnProgressPing` fixes the CLASS instead of one instance: a
 * caller starts it when a phase begins awaiting and stops it when the phase
 * settles, and it re-pings on an interval for the phase's whole lifetime —
 * `message-processor.ts`'s `preStreamPhase` wraps every pre-stream phase with
 * it, so no phase (present or future) can starve the watchdog by simply being
 * slow. This intentionally trades away part of the original "a genuinely
 * wedged setup phase still fires" guarantee documented above: a phase that
 * hangs FOREVER inside `preStreamPhase` now also pings forever and never
 * trips the idle guard on its own — the `totalMs` hard ceiling (when armed)
 * and the phase's OWN internal deadline (if any) are what bound it instead.
 */

/** Wall-clock instant of the most recent ping. 0 = never pinged. */
let lastPingMs = 0;

/** Record forward progress: a request to the provider was just issued. */
export function pingTurnProgress(now = Date.now()): void {
  lastPingMs = now;
}

/**
 * Interval (ms) between pings while `startPeriodicTurnProgressPing` is
 * running. Must stay comfortably below the turn watchdog's `idleMs` (default
 * 120_000) so every re-arm window sees at least one ping. Range 10–60_000 —
 * the low end (like `MUONROI_COMPACTION_PROPOSER_TIMEOUT_MS`'s 1_000 floor)
 * exists only so tests can scale the whole watchdog down to fast real timers
 * instead of fake ones. Env override: MUONROI_TURN_PROGRESS_PING_INTERVAL_MS.
 * Default 15_000.
 */
function getTurnProgressPingIntervalMs(): number {
  const raw = Number.parseInt(process.env.MUONROI_TURN_PROGRESS_PING_INTERVAL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 60_000) return raw;
  return 15_000;
}

/**
 * Start pinging turn progress immediately and then on an interval, for the
 * duration of some awaited operation that produces no yielded `StreamChunk`
 * of its own (a pre-stream phase, or a provider request awaiting its first
 * byte). Returns a `stop` function — the caller MUST call it exactly once the
 * operation settles (success or failure), on every code path, or the interval
 * leaks for the rest of the process (harmless since it is `unref`'d, but it
 * keeps pinging, which can mask an unrelated LATER idle turn).
 *
 * The interval is `unref`'d so it never keeps the event loop alive on its
 * own, and `stop` is idempotent.
 */
export function startPeriodicTurnProgressPing(intervalMs: number = getTurnProgressPingIntervalMs()): () => void {
  pingTurnProgress();
  const timer = setInterval(() => pingTurnProgress(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
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
