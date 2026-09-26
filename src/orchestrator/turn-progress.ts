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
 * slow.
 *
 * Round 6 (G8 HIGH A) — round 5's pinger had NO ceiling of its own, which a
 * refuter caught as a REGRESSION on the original "a genuinely wedged setup
 * phase still fires" guarantee above: a phase that never settles now pinged
 * FOREVER and could never trip the idle guard, worse than before round 5.
 * `startPeriodicTurnProgressPing` now takes an optional `maxMs` — past it,
 * the pinger stops on its own (`onCeiling` fires once, for the caller to log
 * why) and the ordinary idle rule applies again; the wedged phase itself is
 * NOT cancelled, only this mechanism's vouching for it. `preStreamPhase`
 * passes `getPrestreamPhaseMaxPingMs()` (settings.ts, default 180s); the
 * first-token callers (`tool-engine.ts`, `stream-runner.ts`) pass
 * `getFirstTokenTimeoutMs()`. A caller that omits `maxMs` gets NO ceiling —
 * only appropriate when it has its own hard bound already (a council call
 * bounded by its own deadline signal).
 *
 * Round 6 also closes a second gap: a pinger is tied to the TURN that
 * started it via a monotonic generation counter
 * (`beginTurnGeneration`/`withTurnWatchdog`). An interval from a turn that
 * has already ended (killed by the watchdog, completed, or itself hit its
 * `maxMs` ceiling) stops pinging the instant it notices a NEWER turn has
 * begun — so an orphaned interval from turn N can never reset turn N+1's
 * idle clock. Every ping (immediate or interval) is gated on this check
 * BEFORE it touches the shared `lastPingMs`, not just at pinger start.
 */

/** Wall-clock instant of the most recent ping. 0 = never pinged. */
let lastPingMs = 0;

/**
 * Monotonic id, bumped once per top-level turn (see `beginTurnGeneration`).
 * A `startPeriodicTurnProgressPing` pinger captures this at start and checks
 * it on every tick — a mismatch means a NEWER turn has begun since, so the
 * pinger is orphaned and must stop without touching `lastPingMs`.
 */
let currentTurnGeneration = 0;

/** Record forward progress: a request to the provider was just issued. */
export function pingTurnProgress(now = Date.now()): void {
  lastPingMs = now;
}

/**
 * Begin a new turn generation. Call exactly once per top-level turn (or
 * continuation) — `turn-watchdog.ts`'s `withTurnWatchdog` calls this at
 * entry, since that is invoked once per turn attempt. Invalidates every
 * earlier generation's in-flight pingers: an interval started during turn N
 * silently stops itself (no more pings) as soon as this runs for turn N+1,
 * even if turn N's own code never explicitly stopped it.
 */
export function beginTurnGeneration(): number {
  currentTurnGeneration += 1;
  return currentTurnGeneration;
}

/** @testonly Read the current turn generation without bumping it. */
export function __getCurrentTurnGenerationForTests(): number {
  return currentTurnGeneration;
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

/** Options for {@link startPeriodicTurnProgressPing}. */
export interface PeriodicTurnProgressPingOptions {
  /** Interval between pings. Defaults to `getTurnProgressPingIntervalMs()`. */
  intervalMs?: number;
  /**
   * Ceiling (ms) after which the pinger stops on its own, even if `stop()`
   * was never called — the guarded operation may still be running, but this
   * mechanism no longer vouches for it, so the ordinary idle watchdog rule
   * applies again. Omit (or <= 0) for NO ceiling — only correct when the
   * caller already has its own hard bound on the operation (e.g. a call
   * already racing its own deadline signal).
   */
  maxMs?: number;
  /**
   * Called exactly once, synchronously, if/when `maxMs` is reached before
   * `stop()` was called. Use it to log which operation this happened to
   * (breadcrumb / toast) — the pinger itself has no name to offer.
   */
  onCeiling?: () => void;
}

/**
 * Start pinging turn progress immediately and then on an interval, for the
 * duration of some awaited operation that produces no yielded `StreamChunk`
 * of its own (a pre-stream phase, a provider request awaiting its first
 * byte, or a sub-agent/council call the top-level turn cannot otherwise see
 * progress from). Returns a `stop` function — the caller MUST call it exactly
 * once the operation settles (success or failure), on every code path.
 * `stop` is idempotent and safe to call after the pinger already stopped
 * itself (ceiling reached, or orphaned by a newer turn).
 *
 * Two independent safety nets bound this beyond the caller's own `stop()`:
 *   - `maxMs` (see {@link PeriodicTurnProgressPingOptions}) — a per-pinger
 *     ceiling.
 *   - Turn generation — see the module doc comment. A pinger orphaned by a
 *     newer turn (`beginTurnGeneration`) stops on its very next tick.
 *
 * The interval is `unref`'d so it never keeps the event loop alive on its
 * own.
 */
export function startPeriodicTurnProgressPing(opts: PeriodicTurnProgressPingOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? getTurnProgressPingIntervalMs();
  const maxMs = opts.maxMs;
  const myGeneration = currentTurnGeneration;
  const startedAt = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
  };

  const tick = (): void => {
    if (stopped) return;
    if (myGeneration !== currentTurnGeneration) {
      // Orphaned: a newer turn began since this pinger started. Stop WITHOUT
      // pinging — writing lastPingMs here would falsely vouch for the new
      // turn on this stale pinger's behalf.
      stop();
      return;
    }
    if (maxMs !== undefined && maxMs > 0 && Date.now() - startedAt >= maxMs) {
      stop();
      opts.onCeiling?.();
      return;
    }
    pingTurnProgress();
  };

  tick();
  if (!stopped) {
    timer = setInterval(tick, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  }
  return stop;
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
