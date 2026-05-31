import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStallWatchdog, STALL_ABORT_REASON } from "./stall-watchdog.js";

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
