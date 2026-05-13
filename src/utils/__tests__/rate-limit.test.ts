import { describe, expect, it, vi } from "vitest";
import { withRateLimitBackoff } from "../rate-limit.js";

describe("withRateLimitBackoff", () => {
  it("returns value on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRateLimitBackoff(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 up to maxRetries", async () => {
    const err: any = new Error("rate limit");
    err.status = 429;
    const fn = vi.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValue("ok");
    const result = await withRateLimitBackoff(fn, { delays: [1, 1] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries=3 total attempts", async () => {
    const err: any = new Error("429");
    err.status = 429;
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRateLimitBackoff(fn, { delays: [1] })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-429 immediately", async () => {
    const err = new Error("500 boom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRateLimitBackoff(fn)).rejects.toThrow("500 boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("matches /429/ in message even without status", async () => {
    const err = new Error("got 429 from server");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const result = await withRateLimitBackoff(fn, { delays: [1] });
    expect(result).toBe("ok");
  });
});
