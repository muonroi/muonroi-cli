/**
 * Request pacer — bounds dispatch to the limits `catalog.json` declares.
 *
 * These tests reproduce the measured defect. On 2026-09-06 a `/ideal` run on
 * StepFun dispatched 15 requests inside the 60s window before each rate-limit
 * error, against a catalog-declared `requests_per_minute: 10`, and the provider
 * answered HTTP 429 `{"type":"rate_limited"}` — "current: 11, limit: 10". The
 * BEFORE tests below assert that unpaced dispatch really does exceed the declared
 * budget; the AFTER tests assert the pacer bounds it.
 *
 * The clock is injected, so nothing here sleeps in wall time.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { catalogModelToModelInfo } from "../../models/catalog-client.js";
import type { ModelRateLimits } from "../../types/index.js";
import {
  __rateLimiterStateForTests,
  __resetRateLimiterForTests,
  acquireRateLimitSlot,
  type PacerClock,
  RATE_LIMIT_WINDOW_MS,
  UNDECLARED_RATE_LIMITS,
} from "../rate-limiter.js";

/**
 * A virtual clock. `sleep` jumps time forward instead of waiting, so a 60s
 * rolling window is exercised in microseconds and the assertions are about
 * ORDERING and COUNTS rather than wall-clock timing (which would flake).
 */
function makeClock(start = 1_000_000): PacerClock & { advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Max dispatches observed in any rolling 60s window over a list of instants. */
function maxInAnyWindow(instants: number[], windowMs = RATE_LIMIT_WINDOW_MS): number {
  let best = 0;
  for (const anchor of instants) {
    const n = instants.filter((x) => x > anchor - windowMs && x <= anchor).length;
    if (n > best) best = n;
  }
  return best;
}

const STEPFUN_LIKE: ModelRateLimits = { concurrency: 5, requestsPerMinute: 10 };

beforeEach(() => {
  __resetRateLimiterForTests();
});

describe("rate-limiter — the declared limit reaches runtime at all", () => {
  it("maps catalog rate_limits into ModelInfo (the field that used to be dropped)", () => {
    const info = catalogModelToModelInfo({
      id: "m",
      name: "M",
      provider: "p",
      tier: "routine",
      context_window: 1000,
      max_output_tokens: 100,
      input_price_per_million: 1,
      output_price_per_million: 1,
      reasoning: false,
      description: "d",
      rate_limits: { concurrency: 5, requests_per_minute: 10, tokens_per_minute: 5_000_000 },
    } as never);
    expect(info.rateLimits).toEqual({ concurrency: 5, requestsPerMinute: 10, tokensPerMinute: 5_000_000 });
  });

  it("leaves rateLimits undefined when the catalog declares none", () => {
    const info = catalogModelToModelInfo({
      id: "m",
      name: "M",
      provider: "p",
      tier: "routine",
      context_window: 1000,
      max_output_tokens: 100,
      input_price_per_million: 1,
      output_price_per_million: 1,
      reasoning: false,
      description: "d",
    } as never);
    expect(info.rateLimits).toBeUndefined();
  });
});

describe("rate-limiter — requests per minute", () => {
  it("BEFORE: unpaced dispatch exceeds the declared limit (reproduces the defect)", () => {
    // The killed run's own shape: 15 calls ~3s apart, no limiter in the path.
    const instants: number[] = [];
    for (let i = 0; i < 15; i++) instants.push(1_000_000 + i * 3_000);
    // 15 requests inside 60s against a declared ceiling of 10 — exactly what the
    // DB showed in the 60s before each 429.
    expect(maxInAnyWindow(instants)).toBe(15);
    expect(maxInAnyWindow(instants)).toBeGreaterThan(STEPFUN_LIKE.requestsPerMinute!);
  });

  /**
   * Acquire and immediately release, so these RPM tests exercise the rolling
   * window WITHOUT also holding the concurrency semaphore. (Leaving leases open
   * is not a test artefact to paper over: an un-released lease correctly blocks
   * once `concurrency` in-flight calls are outstanding — which is exactly why
   * the gate releases in a `finally` and behind a watchdog.)
   */
  async function pace(key: string, clock: PacerClock) {
    const lease = await acquireRateLimitSlot(key, STEPFUN_LIKE, clock);
    lease.release();
    return lease;
  }

  it("AFTER: paced dispatch never exceeds the declared limit in any rolling window", async () => {
    const clock = makeClock();
    const dispatched: number[] = [];
    // 25 back-to-back calls — the pathological case: no natural spacing at all.
    for (let i = 0; i < 25; i++) {
      await pace("stepfun", clock);
      dispatched.push(clock.now());
    }
    expect(dispatched).toHaveLength(25);
    expect(maxInAnyWindow(dispatched)).toBeLessThanOrEqual(STEPFUN_LIKE.requestsPerMinute!);
  });

  it("does not delay a burst that already fits the budget", async () => {
    const clock = makeClock();
    const t0 = clock.now();
    for (let i = 0; i < 10; i++) await pace("stepfun", clock);
    // Exactly at the ceiling — the tenth call must still go immediately.
    expect(clock.now()).toBe(t0);
  });

  it("holds the 11th call until the window has room, and reports the wait", async () => {
    const clock = makeClock();
    for (let i = 0; i < 10; i++) await pace("stepfun", clock);
    const lease = await pace("stepfun", clock);
    const rpmWait = lease.waits.find((w) => w.kind === "requests-per-minute");
    expect(rpmWait).toBeDefined();
    expect(rpmWait?.limit).toBe(10);
    expect(rpmWait?.waitMs).toBe(RATE_LIMIT_WINDOW_MS);
  });

  it("lets the window drain over time instead of holding forever", async () => {
    const clock = makeClock();
    for (let i = 0; i < 10; i++) await pace("stepfun", clock);
    clock.advance(RATE_LIMIT_WINDOW_MS + 1);
    const lease = await pace("stepfun", clock);
    expect(lease.waits).toEqual([]);
  });

  it("spreads simultaneous arrivals across windows instead of stampeding one (no thundering herd)", async () => {
    const clock = makeClock();
    const t0 = clock.now();
    for (let i = 0; i < 10; i++) await pace("stepfun", clock); // window now full, all at t0

    // 15 callers arrive at the SAME instant into a full window — the case that
    // breaks a naive limiter, where every caller samples "full", sleeps the same
    // duration, and they all wake together and refill the window instantly.
    // Reserving before awaiting means they take slots in arrival order: the first
    // 10 fit the window that opens at t0+60s, and the remaining 5 must be pushed
    // out to the NEXT window rather than piling onto the same one.
    const reserved = await Promise.all(
      Array.from({ length: 15 }, async () => {
        const l = await acquireRateLimitSlot("stepfun", STEPFUN_LIKE, makeClock(t0));
        l.release();
        return t0 + (l.waits.find((w) => w.kind === "requests-per-minute")?.waitMs ?? 0);
      }),
    );

    expect(reserved.filter((t) => t === t0 + RATE_LIMIT_WINDOW_MS)).toHaveLength(10);
    expect(reserved.filter((t) => t === t0 + 2 * RATE_LIMIT_WINDOW_MS)).toHaveLength(5);
    // The whole schedule — the original 10 plus all 15 — still respects the ceiling.
    const all = [...Array.from({ length: 10 }, () => t0), ...reserved];
    expect(maxInAnyWindow(all)).toBeLessThanOrEqual(STEPFUN_LIKE.requestsPerMinute!);
  });

  it("keys the window per provider — one provider's budget does not consume another's", async () => {
    const clock = makeClock();
    for (let i = 0; i < 10; i++) await pace("stepfun", clock);
    const other = await pace("some-other-provider", clock);
    expect(other.waits).toEqual([]);
  });
});

describe("rate-limiter — undeclared limits", () => {
  it("declares its default explicitly rather than inventing a number", () => {
    expect(UNDECLARED_RATE_LIMITS.requestsPerMinute).toBeUndefined();
    expect(UNDECLARED_RATE_LIMITS.concurrency).toBeUndefined();
  });

  it("never throttles a model whose catalog entry declares no limits", async () => {
    const clock = makeClock();
    const t0 = clock.now();
    for (let i = 0; i < 200; i++) await acquireRateLimitSlot("unknown-provider", undefined, clock);
    // Not one millisecond of delay: an undeclared model behaves exactly as it did
    // before the pacer existed.
    expect(clock.now()).toBe(t0);
    expect(__rateLimiterStateForTests("unknown-provider")).toBeUndefined();
  });
});

describe("rate-limiter — concurrency", () => {
  const CONC: ModelRateLimits = { concurrency: 2 };

  it("admits up to the declared number of simultaneous calls", async () => {
    const clock = makeClock();
    const a = await acquireRateLimitSlot("p", CONC, clock);
    const b = await acquireRateLimitSlot("p", CONC, clock);
    expect(a.waits).toEqual([]);
    expect(b.waits).toEqual([]);
    expect(__rateLimiterStateForTests("p")?.inFlight).toBe(2);
  });

  it("holds the call past the ceiling until a slot is released", async () => {
    const clock = makeClock();
    const a = await acquireRateLimitSlot("p", CONC, clock);
    await acquireRateLimitSlot("p", CONC, clock);
    let admitted = false;
    const pending = acquireRateLimitSlot("p", CONC, clock).then((l) => {
      admitted = true;
      return l;
    });
    await Promise.resolve();
    expect(admitted).toBe(false); // third call is queued, not dispatched
    a.release();
    await pending;
    expect(admitted).toBe(true);
  });

  it("never admits past the ceiling when a release and a fresh arrival race", async () => {
    const clock = makeClock();
    const a = await acquireRateLimitSlot("p", CONC, clock);
    await acquireRateLimitSlot("p", CONC, clock); // at the ceiling of 2
    const queued = acquireRateLimitSlot("p", CONC, clock); // waits
    await Promise.resolve();

    // Release, then have a NEW caller arrive in the same microtask window the
    // woken waiter has not yet resumed in. A limiter that decrements on release
    // and re-increments in the waiter admits BOTH here, putting 3 in flight
    // against a ceiling of 2.
    a.release();
    let freshAdmitted = false;
    const fresh = acquireRateLimitSlot("p", CONC, clock).then((l) => {
      freshAdmitted = true;
      return l;
    });
    const q = await queued;

    // The queued caller got the released slot; the fresh arrival must still be
    // waiting, and the ceiling must not have been breached.
    expect(freshAdmitted).toBe(false);
    expect(__rateLimiterStateForTests("p")?.inFlight).toBe(CONC.concurrency);

    q.release(); // hands the slot on to the fresh arrival
    await fresh;
    expect(__rateLimiterStateForTests("p")?.inFlight).toBe(CONC.concurrency);
  });

  it("release is idempotent — a double release cannot inflate the budget", async () => {
    const clock = makeClock();
    const a = await acquireRateLimitSlot("p", CONC, clock);
    a.release();
    a.release();
    expect(__rateLimiterStateForTests("p")?.inFlight).toBe(0);
  });
});
