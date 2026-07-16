import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStallWatchdog } from "../stall-watchdog.js";

describe("createStallWatchdog — interactive suppress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does NOT fire while suppressed, then fires after suppression lifts", () => {
    let suppressed = true;
    const wd = createStallWatchdog(1000, undefined, undefined, () => suppressed);

    // Past the timeout, but suppressed → re-armed, not fired.
    vi.advanceTimersByTime(3000);
    expect(wd.fired()).toBe(false);
    expect(wd.signal.aborted).toBe(false);

    // Lift suppression; the next timeout window fires.
    suppressed = false;
    vi.advanceTimersByTime(1000);
    expect(wd.fired()).toBe(true);
    expect(wd.signal.aborted).toBe(true);
  });

  it("fires normally when no suppress gate is provided", () => {
    const wd = createStallWatchdog(1000);
    vi.advanceTimersByTime(1000);
    expect(wd.fired()).toBe(true);
  });

  it("pet() re-arms and the suppress gate still holds it open", () => {
    let suppressed = false;
    const wd = createStallWatchdog(1000, undefined, undefined, () => suppressed);
    vi.advanceTimersByTime(600);
    wd.pet(); // reset
    suppressed = true;
    vi.advanceTimersByTime(5000); // would have fired several times, but suppressed
    expect(wd.fired()).toBe(false);
  });
});
