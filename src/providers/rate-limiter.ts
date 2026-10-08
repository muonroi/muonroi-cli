/**
 * src/providers/rate-limiter.ts
 *
 * Proactive request pacer — keeps outbound provider calls inside the limits the
 * catalog DECLARES for the model, instead of discovering them as HTTP 429s.
 *
 * WHY THIS EXISTS (measured, 2026-09-06)
 * --------------------------------------
 * A `/ideal` run on StepFun models died mid-implementation. Trace:
 *   - `catalog.json` declares `rate_limits.requests_per_minute: 10` on all nine
 *     stepfun models. That value was validated by zod, asserted by a unit test,
 *     and read by NOTHING: `catalogModelToModelInfo` dropped it, so it never
 *     reached runtime. (Same shape as the earlier `max_output_tokens` defect.)
 *   - The run dispatched 15 requests in the 60s window before EACH rate-limit
 *     error, and 90 of its 171 calls were dispatched while the trailing-60s
 *     count was already above 10.
 *   - StepFun answered `HTTP 429 {"type":"rate_limited"}` — "request limited RPM
 *     reached, current: 11, limit: 10". Reproduced directly against the live API:
 *     after a 70s drain, requests 1-10 succeed and the 11th 429s, exactly the
 *     declared number. (Enforcement is intermittent — other bursts ran to 18
 *     clean — so the pre-fix behaviour is a gamble, not a guaranteed failure.)
 *   - Three of those 429s reached terminal error state; the last one exhausted
 *     the retry loop on the main agent turn, produced a zero-length response,
 *     and ended a ~20 minute run that had already written correct code.
 *
 * WHY RETRY WAS NOT ENOUGH (and why this is not a duplicate of it)
 * ---------------------------------------------------------------
 * `withStreamRetry` (src/orchestrator/retry-stream.ts) already classifies 429 as
 * transient (`retry-classifier.ts:125,165`) and retries with exponential backoff
 * — but that backoff is `500 → 2000 → 8000` ms, capped at
 * `DEFAULT_MAX_DELAY_MS = 8_000`. A per-MINUTE budget cannot be waited out by an
 * 8-second ceiling: in the killed run the two recorded retry delays were 530 ms
 * and 1694 ms against a 60s window. Retry is the REACTIVE backstop and stays
 * exactly as it is; this module is the PROACTIVE half that keeps most calls from
 * needing it. They compose without fighting: the pacer sits INSIDE the model
 * wrapper, so a retry's re-issued call is paced too, rather than hammering a
 * window that is already full.
 *
 * SCOPE — what is and is not enforced
 * -----------------------------------
 *  - `requests_per_minute` — enforced, as a rolling window (see below).
 *  - `concurrency`         — enforced, as a FIFO semaphore.
 *  - `tokens_per_minute`   — deliberately NOT enforced. A call's token cost is
 *    not known until the response arrives (output tokens are unknowable up
 *    front), so any pre-flight enforcement would have to guess. The declared
 *    stepfun value is 5,000,000/min against a measured peak of ~49k input tokens
 *    per call — three orders of magnitude of headroom — so a guess would buy
 *    nothing and could throttle a correct run. Revisit only with measured
 *    evidence of a TPM rejection.
 *
 * ROLLING WINDOW, NOT A FIXED ONE
 * -------------------------------
 * The pacer allows at most N dispatches in ANY 60s span. That is safe whatever
 * the server actually does: a limiter that never exceeds N per rolling 60s also
 * never exceeds N inside a fixed calendar minute, nor inside any shorter window
 * the provider might use. (The server's exact recovery semantics were probed and
 * NOT pinned down — rejected requests appear to consume budget themselves, which
 * confounds the measurement — so the conservative reading is the one encoded
 * here rather than a reverse-engineered guess.)
 *
 * ZERO HARDCODE
 * -------------
 * Nothing here names a provider or a number. Limits arrive from
 * `ModelInfo.rateLimits`, which comes from `catalog.json` via
 * `catalogModelToModelInfo`. A model whose catalog entry declares no
 * `rate_limits` is governed by `UNDECLARED_RATE_LIMITS` below — an explicit,
 * exported, documented policy, not a silent default.
 *
 * Disable entirely with `MUONROI_RATE_LIMIT=0`.
 */

import type { ModelRateLimits } from "../types/index.js";

/** Length of the rolling window a `requests_per_minute` budget is measured over. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * The DECLARED policy for a model whose catalog entry publishes no `rate_limits`.
 *
 * Both fields are `undefined`, which this module reads as "no ceiling" — such a
 * model is dispatched unpaced. That is a deliberate policy choice, not an
 * oversight, and not a silent fallback:
 *
 *  - Inventing a number for a provider we have measured nothing about would be a
 *    hardcoded guess about someone else's API, which is exactly what the Zero
 *    Hardcode rule forbids. A wrong guess is worse than none: it would throttle
 *    every un-annotated model into slowness for no evidenced reason.
 *  - Today only the stepfun models declare `rate_limits`; every other model in
 *    the catalog is therefore unpaced, i.e. behaviour is IDENTICAL to before this
 *    module existed for all of them. The pacer can only ever slow a model whose
 *    catalog entry asked for it.
 *
 * To pace a provider, publish its real numbers in `catalog.json`. That is the
 * single place limits are declared.
 */
export const UNDECLARED_RATE_LIMITS: ModelRateLimits = Object.freeze({
  concurrency: undefined,
  requestsPerMinute: undefined,
  tokensPerMinute: undefined,
});

/** Why a call was made to wait. Distinguishes the two independent budgets. */
export type RateLimitKind = "requests-per-minute" | "concurrency";

/** Reported to the caller so a wait can be surfaced to a driving agent. */
export interface RateLimitWait {
  kind: RateLimitKind;
  /** The declared ceiling that produced the wait. */
  limit: number;
  /** How long the call was actually held, in ms. */
  waitMs: number;
}

/** Injection seam so tests drive the clock instead of sleeping in wall time. */
export interface PacerClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function pacingDisabled(): boolean {
  return process.env.MUONROI_RATE_LIMIT === "0";
}

/**
 * Per-key pacing state.
 *
 * `dispatches` holds RESERVED dispatch timestamps, not observed ones. Reserving
 * before awaiting is what makes concurrent callers correct: N callers that all
 * arrive while the window is full each take a distinct future slot in arrival
 * order, instead of all sampling the same "window is full" state, all sleeping
 * the same duration, and all waking into a thundering herd that re-fills the
 * window instantly.
 */
interface PacerState {
  dispatches: number[];
  inFlight: number;
  waiters: Array<() => void>;
}

const states = new Map<string, PacerState>();

function stateFor(key: string): PacerState {
  let s = states.get(key);
  if (!s) {
    s = { dispatches: [], inFlight: 0, waiters: [] };
    states.set(key, s);
  }
  return s;
}

/**
 * Drop reservations that have aged out of the rolling window.
 * `dispatches` is kept sorted because reservations are always monotonic.
 */
function prune(state: PacerState, now: number): void {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let i = 0;
  while (i < state.dispatches.length && state.dispatches[i]! <= cutoff) i++;
  if (i > 0) state.dispatches.splice(0, i);
}

/**
 * Reserve the next permissible dispatch instant for `key`.
 *
 * Returns the reserved timestamp. When the rolling window already holds `rpm`
 * reservations, the new one is placed exactly one window after the reservation
 * that must age out first — `dispatches[len - rpm]` — which is the earliest
 * instant at which the window has room again.
 */
function reserveSlot(state: PacerState, rpm: number, now: number): number {
  prune(state, now);
  const len = state.dispatches.length;
  const at = len < rpm ? now : Math.max(now, state.dispatches[len - rpm]! + RATE_LIMIT_WINDOW_MS);
  state.dispatches.push(at);
  return at;
}

/**
 * Acquire a concurrency slot, queueing FIFO when the ceiling is reached.
 *
 * Returns whether the caller was actually QUEUED. Callers must not infer that
 * from elapsed time: `acquireConcurrency` is async, so even the free-slot path
 * yields a microtask, and `Date.now()` routinely ticks over across it. Reporting
 * on elapsed time alone therefore announced phantom "waited 1ms" holds on calls
 * that were never delayed at all — measured live against api.stepfun.ai.
 */
async function acquireConcurrency(state: PacerState, limit: number): Promise<boolean> {
  if (state.inFlight < limit) {
    state.inFlight++;
    return false;
  }
  // No increment on this path: the slot is HANDED OVER by releaseConcurrency,
  // which keeps `inFlight` unchanged across the transfer (see below).
  await new Promise<void>((resolve) => state.waiters.push(resolve));
  return true;
}

/**
 * Release a slot — to the next waiter if there is one, otherwise to the pool.
 *
 * The slot is transferred WITHOUT dipping `inFlight`. Decrementing first and
 * letting the woken waiter re-increment would open a window: waking a waiter is
 * a microtask, so a fresh caller arriving in between sees `inFlight < limit`,
 * takes the slot, and then the waiter increments too — putting two calls in
 * flight against a ceiling of one. Handing the slot straight over makes that
 * unrepresentable, and preserves FIFO order into the bargain.
 */
function releaseConcurrency(state: PacerState): void {
  const next = state.waiters.shift();
  if (next) {
    next();
    return;
  }
  state.inFlight--;
}

/** Handle returned by {@link acquireRateLimitSlot}; MUST be released. */
export interface RateLimitLease {
  /** Waits actually incurred, in the order they were incurred. Empty when the call was not delayed. */
  waits: RateLimitWait[];
  /**
   * Whether this lease actually holds a concurrency slot. `false` when the model
   * declares no `concurrency` — the caller then has nothing to release and must
   * not pay the cost of tracking a stream to its end.
   */
  holdsSlot: boolean;
  /** Release the concurrency slot. Idempotent; a no-op when `holdsSlot` is false. */
  release: () => void;
}

/**
 * Hold the caller until dispatching is within the declared budgets for `key`.
 *
 * Order is deliberate: the rolling-window wait happens FIRST, and only then is a
 * concurrency slot taken. Taking the concurrency slot first would let calls that
 * are merely waiting on the clock occupy the in-flight budget, so a provider with
 * `concurrency: 5` would idle five slots on sleeping calls. The cost of this
 * order is that a call can drift slightly later than its reserved instant when
 * concurrency is saturated — drift is always toward FEWER requests per window,
 * i.e. the safe direction.
 */
export async function acquireRateLimitSlot(
  key: string,
  limits: ModelRateLimits | undefined,
  clock: PacerClock = realClock,
  onWait?: (wait: RateLimitWait) => void,
): Promise<RateLimitLease> {
  const waits: RateLimitWait[] = [];
  /**
   * Announce a wait the moment it is DECIDED, never after it elapses.
   *
   * Reporting on completion would make the hold invisible for exactly as long as
   * it lasts — a 60s pause that a driver only learns about once it is over is
   * indistinguishable from a hang while it matters. Recorded on the lease too,
   * for callers that only inspect the result.
   */
  const noteWait = (wait: RateLimitWait): void => {
    waits.push(wait);
    onWait?.(wait);
  };
  const effective = limits ?? UNDECLARED_RATE_LIMITS;
  const rpm = effective.requestsPerMinute;
  const concurrency = effective.concurrency;

  if (pacingDisabled() || (!rpm && !concurrency)) {
    return { waits, holdsSlot: false, release: () => {} };
  }

  const state = stateFor(key);

  if (typeof rpm === "number" && rpm > 0) {
    const now = clock.now();
    const at = reserveSlot(state, rpm, now);
    const waitMs = at - now;
    if (waitMs > 0) {
      noteWait({ kind: "requests-per-minute", limit: rpm, waitMs });
      await clock.sleep(waitMs);
    }
  }

  if (typeof concurrency === "number" && concurrency > 0) {
    const before = clock.now();
    const queued = await acquireConcurrency(state, concurrency);
    const waitMs = queued ? clock.now() - before : 0;
    // Asymmetry with the RPM wait above, deliberately: a concurrency wait's
    // duration is not knowable in advance (it ends when some other call finishes),
    // so it can only be reported once measured. That is acceptable here because a
    // concurrency wait means other calls ARE actively in flight — the run is
    // visibly working — whereas an RPM wait is a pure clock hold with nothing
    // running, which is the case that must never look like a hang.
    if (waitMs > 0) noteWait({ kind: "concurrency", limit: concurrency, waitMs });
    let released = false;
    return {
      waits,
      holdsSlot: true,
      release: () => {
        if (released) return;
        released = true;
        releaseConcurrency(state);
      },
    };
  }

  return { waits, holdsSlot: false, release: () => {} };
}

/**
 * Test-only reset of all pacing state.
 *
 * Exported because the state is module-level (one pacer per provider per
 * process, which is the point — a per-call limiter would limit nothing), and a
 * test that shares reservations with the previous test measures the previous
 * test.
 */
export function __resetRateLimiterForTests(): void {
  states.clear();
}

/** Test-only view of the reserved dispatch instants for a key. */
export function __rateLimiterStateForTests(key: string): { dispatches: number[]; inFlight: number } | undefined {
  const s = states.get(key);
  return s ? { dispatches: [...s.dispatches], inFlight: s.inFlight } : undefined;
}
