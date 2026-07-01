import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withVisibleRetry } from "../visible-retry.js";

describe("withVisibleRetry", () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Intercept setTimeout to execute immediately (in a microtask) so tests run instantly
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      Promise.resolve().then(() => cb());
      return {} as any;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it("returns result on first try if no error", async () => {
    const fn = vi.fn(async () => "success");
    const result = await withVisibleRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("retries on 429 status code with backoff", async () => {
    const error = new Error("Too Many Requests");
    (error as { statusCode?: number }).statusCode = 429;

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("success on retry");

    const retryLog: string[] = [];
    const onRetry = (attempt: number, total: number, delayMs: number) => {
      retryLog.push(`attempt=${attempt},total=${total},delayMs=${delayMs}`);
    };

    const promise = withVisibleRetry(fn, { onRetry });
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(retryLog).toEqual(["attempt=0,total=6,delayMs=2000"]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 400 (non-retryable)", async () => {
    const error = new Error("Bad Request");
    (error as { statusCode?: number }).statusCode = 400;

    const fn = vi.fn().mockRejectedValueOnce(error);
    const onRetry = vi.fn();

    const result = withVisibleRetry(fn, { onRetry });

    await expect(result).rejects.toThrow("Bad Request");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("throws final error after maxAttempts exhausted", async () => {
    const error = new Error("Rate limited");
    (error as { statusCode?: number }).statusCode = 429;

    const fn = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();

    const promise = withVisibleRetry(fn, { maxAttempts: 2, onRetry });
    await promise.catch(() => {});

    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("respects custom onRetry hook", async () => {
    const error = new Error("Rate limit: 429");
    (error as { statusCode?: number }).statusCode = 429;

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();

    const promise = withVisibleRetry(fn, {
      delaysMs: [500],
      onRetry,
    });

    await promise;

    expect(onRetry).toHaveBeenCalledOnce();
    const call = onRetry.mock.calls[0]!;
    expect(call[0]).toBe(0); // attempt
    expect(call[1]).toBe(2); // totalAttempts
    expect(call[2]).toBe(500); // delayMs
    expect(call[3]).toBeInstanceOf(Error);
  });

  it("uses exponential backoff by default", async () => {
    const error = new Error("429");
    (error as { statusCode?: number }).statusCode = 429;

    const fn = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValueOnce("success");

    const delays: number[] = [];
    const onRetry = (_attempt: number, _total: number, delayMs: number) => {
      delays.push(delayMs);
    };

    const promise = withVisibleRetry(fn, { maxAttempts: 3, onRetry });
    await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([2000, 4000]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 500+ status codes", async () => {
    const error = new Error("Internal Server Error");
    (error as { statusCode?: number }).statusCode = 503;

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withVisibleRetry(fn, { onRetry });

    await promise;

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![2]).toBe(2000);
  });

  it("retries on 408 timeout status", async () => {
    const error = new Error("Request Timeout");
    (error as { statusCode?: number }).statusCode = 408;

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withVisibleRetry(fn, { onRetry });

    await promise;

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("retries on message containing 'rate limit'", async () => {
    const error = new Error("API returned Rate Limit Exceeded");

    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withVisibleRetry(fn, { onRetry });

    await promise;

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("uses custom delays array", async () => {
    const error = new Error("429");
    (error as { statusCode?: number }).statusCode = 429;

    const fn = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValueOnce("success");

    const delays: number[] = [];
    const onRetry = (_attempt: number, _total: number, delayMs: number) => {
      delays.push(delayMs);
    };

    const promise = withVisibleRetry(fn, {
      maxAttempts: 3,
      delaysMs: [100, 200],
      onRetry,
    });

    await promise;

    expect(delays).toEqual([100, 200]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
