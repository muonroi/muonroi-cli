import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetryInfo } from "../retry-stream.js";
import { withStreamRetry } from "../retry-stream.js";

// Fast no-op delay for all tests
const fastDelay = () => Promise.resolve();

function makeTransientError(msg = "fetch failed", statusCode?: number) {
  return Object.assign(new TypeError(msg), statusCode != null ? { statusCode } : {});
}

function makeNonTransientError(statusCode = 401) {
  return Object.assign(new Error("Unauthorized"), { statusCode });
}

describe("withStreamRetry", () => {
  it("1. succeeds on first attempt — factory called once", async () => {
    const factory = vi.fn().mockResolvedValueOnce("ok");
    const result = await withStreamRetry(factory, { delay: fastDelay });
    expect(result).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("2. transient on attempt 1, success on 2 — factory called twice, onRetry fired once", async () => {
    const retries: RetryInfo[] = [];
    const factory = vi
      .fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce("second");

    const result = await withStreamRetry(factory, {
      delay: fastDelay,
      onRetry: (info) => retries.push(info),
    });

    expect(result).toBe("second");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.maxAttempts).toBe(3);
  });

  it("3. transient on 1+2, success on 3 — onRetry fired twice", async () => {
    const retries: RetryInfo[] = [];
    const factory = vi
      .fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce("third");

    const result = await withStreamRetry(factory, {
      delay: fastDelay,
      onRetry: (info) => retries.push(info),
    });

    expect(result).toBe("third");
    expect(factory).toHaveBeenCalledTimes(3);
    expect(retries).toHaveLength(2);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[1]!.attempt).toBe(2);
  });

  it("4. transient on all 3 — final error thrown after maxAttempts", async () => {
    const err = makeTransientError("ECONNREFUSED");
    const factory = vi.fn().mockRejectedValue(err);

    await expect(
      withStreamRetry(factory, { delay: fastDelay, onRetry: () => {} }),
    ).rejects.toBe(err);

    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("5. non-transient error — no retry, immediate throw", async () => {
    const err = makeNonTransientError(401);
    const factory = vi.fn().mockRejectedValue(err);

    await expect(withStreamRetry(factory, { delay: fastDelay })).rejects.toBe(err);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("6. signal.aborted before first attempt — no factory call, AbortError thrown", async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn().mockResolvedValue("x");

    await expect(
      withStreamRetry(factory, { delay: fastDelay, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("7. signal.aborted between attempts — retry loop bails", async () => {
    const controller = new AbortController();
    let callCount = 0;

    const factory = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Abort during the retry
        controller.abort();
        throw makeTransientError();
      }
      return "should not reach";
    });

    await expect(
      withStreamRetry(factory, {
        delay: () => Promise.resolve(), // fast delay
        signal: controller.signal,
        onRetry: () => {},
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("8. Retry-After header (seconds string) — uses that delay for THIS attempt", async () => {
    const delays: number[] = [];
    const retryAfterErr = Object.assign(new Error("Rate limited"), {
      statusCode: 429,
      retryAfter: "5", // 5 seconds = 5000 ms
    });

    const factory = vi.fn()
      .mockRejectedValueOnce(retryAfterErr)
      .mockResolvedValueOnce("ok");

    const retries: RetryInfo[] = [];
    await withStreamRetry(factory, {
      delay: (ms) => { delays.push(ms); return Promise.resolve(); },
      onRetry: (info) => retries.push(info),
    });

    expect(retries[0]!.nextDelayMs).toBe(5000);
    expect(delays[0]).toBe(5000);
  });

  it("9. jitter stays within ±jitter*delay range", async () => {
    // Run 30 times and check every delay is within ±25% of 500ms base
    const baseDelayMs = 500;
    const jitter = 0.25;
    const spread = baseDelayMs * jitter;
    const min = baseDelayMs - spread;
    const max = baseDelayMs + spread;

    for (let i = 0; i < 30; i++) {
      const delays: number[] = [];
      const factory = vi.fn()
        .mockRejectedValueOnce(makeTransientError())
        .mockResolvedValueOnce("ok");

      await withStreamRetry(factory, {
        maxAttempts: 2,
        baseDelayMs,
        jitter,
        delay: (ms) => { delays.push(ms); return Promise.resolve(); },
      });

      expect(delays[0]).toBeGreaterThanOrEqual(min);
      expect(delays[0]).toBeLessThanOrEqual(max);
    }
  });

  it("10. maxDelayMs cap respected", async () => {
    const delays: number[] = [];
    const factory = vi.fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce("ok");

    await withStreamRetry(factory, {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 1000, // lower cap than default 8000
      jitter: 0, // no jitter so we get exact values
      delay: (ms) => { delays.push(ms); return Promise.resolve(); },
    });

    // attempt 1: 500, attempt 2: 2000 → capped to 1000
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);
  });
});
