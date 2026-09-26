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
 * started it via a generation id (`beginTurnGeneration`/`withTurnWatchdog`).
 * An interval from a turn that has already ended (killed by the watchdog,
 * completed, or itself hit its `maxMs` ceiling) stops pinging once it notices
 * its turn is no longer active — so an orphaned interval from a finished turn
 * can never reset a LATER turn's idle clock. Every ping (immediate or
 * interval) is gated on this check BEFORE it touches the shared
 * `lastPingMs`, not just at pinger start.
 *
 * Round 7 — round 6 modelled this as a single flat "current generation",
 * which a refuter reproduced as a live bug on NESTED turns: `orchestrator.ts`
 * ~2640 (a council continuation) calls `withTurnWatchdog` again on
 * `this.processMessage(...)` from INSIDE the outer top-level turn
 * (~3943's own `withTurnWatchdog`) — the outer turn is still legitimately
 * running (suspended on `yield*` for the inner one to finish), but the flat
 * counter has no way to say "both are current". Bumping it for the inner
 * turn silently orphaned the OUTER turn's still-legit pinger.
 *
 * Fixed with a STACK of active generations instead of one flat value:
 * `beginTurnGeneration` pushes; `endTurnGeneration` (called from
 * `withTurnWatchdog`'s existing `finally`, so it pops on every exit path —
 * normal completion, a thrown error, or early abandonment) pops. A pinger
 * stays valid as long as its captured generation is ANYWHERE in the active
 * stack, not only at the top — nesting no longer orphans the outer turn.
 * "Orphaned" now means precisely: this generation has been POPPED, i.e. the
 * turn that started it has genuinely ended.
 */

/** Wall-clock instant of the most recent ping. 0 = never pinged. */
let lastPingMs = 0;

/** Monotonic id source for turn generations (see `beginTurnGeneration`). */
let nextTurnGeneration = 0;

/**
 * Stack of currently-active turn generations, outermost first. A
 * `startPeriodicTurnProgressPing` pinger captures its generation at start and
 * checks, on every tick, whether that id is STILL somewhere in this stack —
 * absent means the turn that started it has ended (popped), so the pinger is
 * orphaned and must stop without touching `lastPingMs`. Present anywhere
 * (not just at the top) means it is still legitimate, even while a NESTED
 * turn is also active.
 */
const activeTurnGenerations: number[] = [];

/** Record forward progress: a request to the provider was just issued. */
export function pingTurnProgress(now = Date.now()): void {
  lastPingMs = now;
}

/**
 * Begin a new turn generation and push it onto the active stack. Call
 * exactly once per top-level turn (or continuation, including a NESTED one)
 * — `turn-watchdog.ts`'s `withTurnWatchdog` calls this at entry. Pair with
 * `endTurnGeneration` in a `finally` so it is popped on every exit path.
 */
export function beginTurnGeneration(): number {
  nextTurnGeneration += 1;
  const gen = nextTurnGeneration;
  activeTurnGenerations.push(gen);
  return gen;
}

/**
 * End a turn generation — pops it from the active stack. Safe to call even
 * if `gen` is not at the top (defensive: nesting is expected to unwind LIFO,
 * but this does not assume it) or already absent (idempotent).
 */
export function endTurnGeneration(gen: number): void {
  const idx = activeTurnGenerations.lastIndexOf(gen);
  if (idx !== -1) activeTurnGenerations.splice(idx, 1);
}

/** True while `gen` is still somewhere in the active-generation stack. */
export function isTurnGenerationActive(gen: number): boolean {
  return activeTurnGenerations.includes(gen);
}

/** @testonly Snapshot of the active-generation stack, outermost first. */
export function __getActiveTurnGenerationsForTests(): readonly number[] {
  return [...activeTurnGenerations];
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
  const myGeneration = nextTurnGeneration;
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
    if (!isTurnGenerationActive(myGeneration)) {
      // Orphaned: the turn that started this pinger has ended (its
      // generation was popped) — a NESTED turn beginning and ending does NOT
      // orphan this, since the outer generation stays in the stack the whole
      // time. Stop WITHOUT pinging — writing lastPingMs here would falsely
      // vouch for whatever is running now on this stale pinger's behalf.
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

/** Test-only: forget every ping and clear the active-generation stack. */
export function __resetTurnProgressForTests(): void {
  lastPingMs = 0;
  activeTurnGenerations.length = 0;
}
