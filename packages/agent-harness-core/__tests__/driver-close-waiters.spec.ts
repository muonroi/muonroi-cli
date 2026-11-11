import { describe, expect, it, vi } from "vitest";
import { createDriver } from "../src/driver.js";

describe("driver transport closure", () => {
  it("rejects pending and future waits immediately and clears their timeout timers", async () => {
    vi.useFakeTimers();
    try {
      const driver = createDriver({ sendKey: () => {}, sendType: () => {} });
      const pending = driver.wait_for({ idle: true, timeoutMs: 60000 });
      const assertion = expect(pending).rejects.toThrow(/closed|disconnected/i);
      driver._closeAllSubscribers();
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      await expect(driver.wait_for({ idle: true, timeoutMs: 60000 })).rejects.toThrow(/closed|disconnected/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
