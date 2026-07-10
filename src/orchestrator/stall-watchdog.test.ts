import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStallWatchdog,
  type MidLoopStallState,
  STALL_ABORT_REASON,
  type StallRepromptState,
  shouldContinueAfterMidLoopStall,
  shouldRepromptStall,
  stallRepromptBackoffMs,
} from "./stall-watchdog.js";

describe("createStallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts with a TimeoutError when no chunk arrives within timeoutMs", () => {
    const wd = createStallWatchdog(1000);
    expect(wd.signal.aborted).toBe(false);
    expect(wd.fired()).toBe(false);

    vi.advanceTimersByTime(999);
    expect(wd.signal.aborted).toBe(false);

    vi.advanceTimersByTime(2);
    expect(wd.signal.aborted).toBe(true);
    expect(wd.fired()).toBe(true);
    expect((wd.signal.reason as Error)?.name).toBe("TimeoutError");
    expect((wd.signal.reason as Error)?.message).toBe(STALL_ABORT_REASON);
  });

  it("pet() re-arms the timer so an actively-streaming call is NOT aborted", () => {
    const wd = createStallWatchdog(1000);
    // Chunk every 600ms keeps it alive well past the raw timeout.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600);
      wd.pet();
    }
    expect(wd.signal.aborted).toBe(false);
    expect(wd.fired()).toBe(false);
    // ...but a gap longer than timeout after the last chunk still fires.
    vi.advanceTimersByTime(1001);
    expect(wd.fired()).toBe(true);
  });

  it("dispose() stops the timer (no abort after disposal)", () => {
    const wd = createStallWatchdog(1000);
    wd.dispose();
    vi.advanceTimersByTime(5000);
    expect(wd.signal.aborted).toBe(false);
    expect(wd.fired()).toBe(false);
  });

  it("timeoutMs <= 0 disables the watchdog entirely", () => {
    for (const ms of [0, -1, Number.NaN]) {
      const wd = createStallWatchdog(ms);
      vi.advanceTimersByTime(1_000_000);
      expect(wd.signal.aborted).toBe(false);
      expect(wd.fired()).toBe(false);
    }
  });

  it("invokes onFire exactly once when it fires", () => {
    const onFire = vi.fn();
    const wd = createStallWatchdog(1000, onFire);
    vi.advanceTimersByTime(1001);
    expect(wd.fired()).toBe(true);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke onFire when disposed before timeout, or when disabled", () => {
    const onFireA = vi.fn();
    const a = createStallWatchdog(1000, onFireA);
    a.dispose();
    vi.advanceTimersByTime(5000);
    expect(onFireA).not.toHaveBeenCalled();

    const onFireB = vi.fn();
    createStallWatchdog(0, onFireB);
    vi.advanceTimersByTime(5000);
    expect(onFireB).not.toHaveBeenCalled();
  });

  it("pet() after firing is a no-op (does not un-fire)", () => {
    const wd = createStallWatchdog(1000);
    vi.advanceTimersByTime(1001);
    expect(wd.fired()).toBe(true);
    wd.pet();
    expect(wd.fired()).toBe(true);
    expect(wd.signal.aborted).toBe(true);
  });
});

describe("createStallWatchdog — no-forward-progress timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires on the progress timer when pet() keeps the stall timer alive but petProgress() never runs (runaway reasoning)", () => {
    const onFire = vi.fn();
    const onProgressFire = vi.fn();
    // Stall timer 1s, progress timer 10s. Simulate a reasoning model that emits
    // a reasoning chunk every 500ms (pets stall) but never any text/tool output.
    const wd = createStallWatchdog(1000, onFire, { progressTimeoutMs: 10_000, onProgressFire });
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(500);
      wd.pet(); // reasoning-delta arrived: re-arms the stall timer only
    }
    // 15s of "activity" elapsed: the stall timer never fired (petted), but the
    // progress timer (never petted) has fired.
    expect(wd.fired()).toBe(true);
    expect(wd.signal.aborted).toBe(true);
    expect(onProgressFire).toHaveBeenCalledTimes(1);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("petProgress() re-arms the progress timer so a stream producing real output survives", () => {
    const wd = createStallWatchdog(1000, undefined, { progressTimeoutMs: 10_000 });
    // Every 800ms a real output chunk arrives → pet BOTH timers.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(800);
      wd.pet();
      wd.petProgress();
    }
    expect(wd.fired()).toBe(false);
    expect(wd.signal.aborted).toBe(false);
  });

  it("progressTimeoutMs <= 0 disables the progress timer (petProgress is a no-op)", () => {
    const wd = createStallWatchdog(1000, undefined, { progressTimeoutMs: 0 });
    // Keep the stall timer alive forever; with no progress timer, nothing fires.
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(500);
      wd.pet();
    }
    expect(wd.fired()).toBe(false);
  });

  it("dispose() clears BOTH timers", () => {
    const wd = createStallWatchdog(1000, undefined, { progressTimeoutMs: 10_000 });
    wd.dispose();
    vi.advanceTimersByTime(1_000_000);
    expect(wd.fired()).toBe(false);
    expect(wd.signal.aborted).toBe(false);
  });
});

describe("shouldRepromptStall", () => {
  // A clean time-to-first-byte stall: watchdog fired, zero chunks, no text,
  // under the cap, not cancelled — the ONLY case that re-prompts.
  const ttfb = (over: Partial<StallRepromptState> = {}): StallRepromptState => ({
    stallTriggered: true,
    stallRetryCount: 0,
    maxStallRetries: 1,
    chunksThisAttempt: 0,
    assistantTextEmpty: true,
    aborted: false,
    ...over,
  });

  it("re-prompts a time-to-first-byte stall under the cap", () => {
    expect(shouldRepromptStall(ttfb())).toBe(true);
  });

  it("does NOT re-prompt when the watchdog never fired", () => {
    expect(shouldRepromptStall(ttfb({ stallTriggered: false }))).toBe(false);
  });

  it("does NOT re-prompt once the retry cap is reached", () => {
    expect(shouldRepromptStall(ttfb({ stallRetryCount: 1, maxStallRetries: 1 }))).toBe(false);
    // maxStallRetries=0 means the feature is disabled — never re-prompt.
    expect(shouldRepromptStall(ttfb({ stallRetryCount: 0, maxStallRetries: 0 }))).toBe(false);
  });

  it("does NOT re-prompt once a real chunk has arrived (mid-stream stall → rescue)", () => {
    expect(shouldRepromptStall(ttfb({ chunksThisAttempt: 1 }))).toBe(false);
  });

  it("does NOT re-prompt once assistant text has flowed (output would corrupt)", () => {
    expect(shouldRepromptStall(ttfb({ assistantTextEmpty: false }))).toBe(false);
  });

  it("does NOT re-prompt over a genuine user cancel", () => {
    expect(shouldRepromptStall(ttfb({ aborted: true }))).toBe(false);
  });
});

describe("shouldContinueAfterMidLoopStall", () => {
  // A clean mid-loop dead socket: watchdog fired AFTER earlier steps ran
  // (chunksThisAttempt > 0), but the in-flight step produced nothing
  // (chunksThisStep === 0). The ONLY shape that continues. Distinct from the
  // TTFB re-prompt, which requires chunksThisAttempt === 0.
  const midLoop = (over: Partial<MidLoopStallState> = {}): MidLoopStallState => ({
    stallTriggered: true,
    chunksThisAttempt: 132, // 66 prior steps' worth of chunks
    chunksThisStep: 0,
    retryCount: 0,
    maxRetries: 1,
    aborted: false,
    ...over,
  });

  it("continues a mid-loop dead-socket stall under the cap", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop())).toBe(true);
  });

  it("does NOT continue when the watchdog never fired", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop({ stallTriggered: false }))).toBe(false);
  });

  it("does NOT continue a time-to-first-byte stall (chunksThisAttempt === 0 → TTFB re-prompt owns it)", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop({ chunksThisAttempt: 0 }))).toBe(false);
  });

  it("does NOT continue when the stalled step already emitted output (would duplicate)", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop({ chunksThisStep: 3 }))).toBe(false);
  });

  it("does NOT continue once the retry cap is reached", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop({ retryCount: 1, maxRetries: 1 }))).toBe(false);
    // maxRetries=0 means the feature is disabled — never continue.
    expect(shouldContinueAfterMidLoopStall(midLoop({ retryCount: 0, maxRetries: 0 }))).toBe(false);
  });

  it("does NOT continue over a genuine user cancel", () => {
    expect(shouldContinueAfterMidLoopStall(midLoop({ aborted: true }))).toBe(false);
  });
});

describe("stallRepromptBackoffMs", () => {
  it("grows exponentially and caps at 4s", () => {
    expect(stallRepromptBackoffMs(1)).toBe(500);
    expect(stallRepromptBackoffMs(2)).toBe(1000);
    expect(stallRepromptBackoffMs(3)).toBe(2000);
    expect(stallRepromptBackoffMs(4)).toBe(4000);
    expect(stallRepromptBackoffMs(5)).toBe(4000);
  });

  it("treats attempt < 1 as the first attempt", () => {
    expect(stallRepromptBackoffMs(0)).toBe(500);
  });
});
