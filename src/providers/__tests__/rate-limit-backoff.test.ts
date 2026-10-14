/**
 * The reactive rate-limit backstop: classification across provider error
 * shapes, Retry-After parsing, the time-budgeted schedule, and the exhausted
 * error the main agent ends up reading.
 */
import { APICallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyStreamError } from "../../orchestrator/retry-classifier.js";
import {
  __resetProviderBackoffForTests,
  isProviderBackoffActive,
  isQuotaExhaustion,
  isRateLimitError,
  isRateLimitFailureText,
  isRateLimitRetryExhausted,
  ProviderRateLimitError,
  plannedRateLimitAttempts,
  RATE_LIMIT_MAX_DELAY_MS,
  rateLimitBackoffMs,
  rateLimitRetryBudgetMs,
  retryAfterMsFromError,
  withProviderRateLimitRetry,
} from "../rate-limit-backoff.js";

function apiError(
  statusCode: number,
  message: string,
  extra: Partial<{ responseBody: string; headers: Record<string, string> }> = {},
) {
  return new APICallError({
    message,
    url: "https://provider.example.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: extra.responseBody,
    responseHeaders: extra.headers,
    isRetryable: statusCode === 429,
  });
}

afterEach(() => {
  __resetProviderBackoffForTests();
  delete process.env.MUONROI_RATE_LIMIT_RETRY_BUDGET_MS;
});

describe("isRateLimitError — generic across provider shapes (no provider-id branches)", () => {
  it.each([
    ["HTTP 429 APICallError (StepFun phrasing)", apiError(429, "Rate limit reached, please try again later.")],
    [
      "HTTP 429 with an OpenAI-style body",
      apiError(429, "Too Many Requests", { responseBody: '{"error":{"type":"requests"}}' }),
    ],
    [
      "HTTP 429 Anthropic rate_limit_error body",
      apiError(429, "x", { responseBody: '{"type":"error","error":{"type":"rate_limit_error"}}' }),
    ],
    ["plain statusCode 429", Object.assign(new Error("whatever"), { statusCode: 429 })],
    ["plain status 429", Object.assign(new Error("whatever"), { status: 429 })],
    ["error named RateLimitError", Object.assign(new Error("slow down"), { name: "RateLimitError" })],
    [
      "status-less JSON type rate_limited",
      new Error('{"type":"rate_limited","message":"request limited RPM reached"}'),
    ],
    ["status-less 'Too Many Requests'", new Error("Too Many Requests")],
    ["proxy-wrapped message", new Error("Console Go upstream: rate-limited by provider")],
    ["wrapped in cause", Object.assign(new Error("stream failed"), { cause: apiError(429, "limit") })],
    [
      "AI SDK RetryError.lastError",
      Object.assign(new Error("Failed after 3 attempts"), { lastError: apiError(429, "x") }),
    ],
  ])("%s", (_label, err) => {
    expect(isRateLimitError(err)).toBe(true);
  });

  it.each([
    ["z.ai balance 429", apiError(429, "Insufficient balance or no resource package. Please recharge.")],
    ["OpenAI quota 429", apiError(429, "You exceeded your current quota, please check your plan and billing details.")],
    ["401 that mentions a limit", apiError(401, "Invalid key (rate limit tier: free)")],
    ["500", apiError(500, "Internal error")],
    ["plain network error", new TypeError("fetch failed")],
    ["non-error", undefined],
  ])("rejects %s", (_label, err) => {
    expect(isRateLimitError(err)).toBe(false);
  });

  it("text variant matches flattened sub-agent failures, but not balance errors", () => {
    expect(isRateLimitFailureText("Task failed: HTTP 429: Rate limit reached, please try again later.")).toBe(true);
    expect(isRateLimitFailureText("Rate limit reached, please try again later.")).toBe(true);
    expect(isRateLimitFailureText("Task failed: HTTP 429: Insufficient balance")).toBe(false);
    expect(isRateLimitFailureText("Task failed: ENOENT")).toBe(false);
    expect(isQuotaExhaustion("insufficient_quota")).toBe(true);
  });
});

describe("retryAfterMsFromError", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");

  it("prefers retry-after-ms, case-insensitively", () => {
    const err = apiError(429, "x", { headers: { "Retry-After-Ms": "1500", "retry-after": "9" } });
    expect(retryAfterMsFromError(err, now)).toBe(1500);
  });

  it("reads retry-after delta-seconds (fractional allowed)", () => {
    expect(retryAfterMsFromError(apiError(429, "x", { headers: { "retry-after": "2.5" } }), now)).toBe(2500);
  });

  it("reads a retry-after HTTP-date", () => {
    const err = apiError(429, "x", { headers: { "retry-after": "Wed, 14 Oct 2026 00:00:30 GMT" } });
    expect(retryAfterMsFromError(err, now)).toBe(30_000);
  });

  it("accepts a pre-parsed retryAfter and searches wrapped errors", () => {
    expect(retryAfterMsFromError(Object.assign(new Error("x"), { retryAfter: 700 }), now)).toBe(700);
    const wrapped = Object.assign(new Error("outer"), {
      cause: apiError(429, "x", { headers: { "retry-after": "3" } }),
    });
    expect(retryAfterMsFromError(wrapped, now)).toBe(3000);
  });

  it("returns null without a hint", () => {
    expect(retryAfterMsFromError(apiError(429, "x"), now)).toBeNull();
  });
});

describe("schedule", () => {
  it("doubles from 4s and caps at one full window", () => {
    const mid = () => 0.5; // zero jitter
    expect([1, 2, 3, 4, 5, 6].map((n) => rateLimitBackoffMs(n, mid))).toEqual([
      4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    // Jitter never exceeds the cap.
    expect(rateLimitBackoffMs(9, () => 1)).toBe(RATE_LIMIT_MAX_DELAY_MS);
  });

  it("plans 8 attempts in the default 4-minute budget", () => {
    expect(rateLimitRetryBudgetMs({})).toBe(240_000);
    // 4+8+16+32+60+60+60 = 240s → 7 retries + the first try.
    expect(plannedRateLimitAttempts(240_000)).toBe(8);
  });

  it("budget env: 0 disables, garbage falls back to the default", () => {
    expect(rateLimitRetryBudgetMs({ MUONROI_RATE_LIMIT_RETRY_BUDGET_MS: "0" })).toBe(0);
    expect(rateLimitRetryBudgetMs({ MUONROI_RATE_LIMIT_RETRY_BUDGET_MS: "nope" })).toBe(240_000);
    expect(rateLimitRetryBudgetMs({ MUONROI_RATE_LIMIT_RETRY_BUDGET_MS: "90000" })).toBe(90_000);
  });
});

describe("withProviderRateLimitRetry", () => {
  /** Fake clock: sleeping advances it, and records each wait. */
  function clock() {
    let t = 0;
    const waits: number[] = [];
    let heldDuringSleep = true;
    return {
      waits,
      held: () => heldDuringSleep,
      now: () => t,
      sleep: async (ms: number) => {
        heldDuringSleep &&= isProviderBackoffActive();
        waits.push(ms);
        t += ms;
      },
    };
  }

  it("waits out a 429 and returns the retried result", async () => {
    const c = clock();
    const run = vi.fn().mockRejectedValueOnce(apiError(429, "Rate limit reached")).mockResolvedValueOnce("ok");
    const infos: unknown[] = [];
    const out = await withProviderRateLimitRetry(run, {
      budgetMs: 240_000,
      now: c.now,
      sleep: c.sleep,
      onRetry: (i) => infos.push(i),
    });
    expect(out).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(c.waits[0]).toBeGreaterThanOrEqual(3_200); // 4s ± 20%
    expect(c.waits[0]).toBeLessThanOrEqual(4_800);
    expect(infos[0]).toMatchObject({ attempt: 1, maxAttempts: 8, hinted: false });
    // The watchdogs were held off for the whole wait, and released after.
    expect(c.held()).toBe(true);
    expect(isProviderBackoffActive()).toBe(false);
  });

  it("honours the provider's Retry-After over the computed step", async () => {
    const c = clock();
    const err = apiError(429, "x", { headers: { "retry-after": "45" } });
    const run = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    await withProviderRateLimitRetry(run, { budgetMs: 240_000, now: c.now, sleep: c.sleep });
    expect(c.waits).toEqual([45_000]);
  });

  it("waits for the coordinated (shared) deadline, not just its own proposal", async () => {
    const c = clock();
    const run = vi.fn().mockRejectedValueOnce(apiError(429, "x")).mockResolvedValueOnce("ok");
    const coordinate = vi.fn(async () => 20_000);
    await withProviderRateLimitRetry(run, { budgetMs: 240_000, now: c.now, sleep: c.sleep, coordinate });
    expect(coordinate).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, hintMs: null }));
    expect(c.waits).toEqual([20_000]);
  });

  it("gives up with an actionable, non-transient error once the budget is spent", async () => {
    const c = clock();
    const original = apiError(429, "Rate limit reached, please try again later.");
    const run = vi.fn().mockRejectedValue(original);
    const p = withProviderRateLimitRetry(run, { provider: "acme", budgetMs: 240_000, now: c.now, sleep: c.sleep });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    const e = err as ProviderRateLimitError;
    expect(e.statusCode).toBe(429);
    expect(e.cause).toBe(original);
    expect(e.message).toContain('"acme" provider account');
    expect(e.message).toContain("shared by every muonroi agent");
    expect(e.message).toContain("launch fewer agents in parallel");
    expect(e.message).toContain("Rate limit reached, please try again later.");
    // Real minutes were waited before giving up (the bug: it gave up at once).
    expect(c.waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(150_000);
    expect(c.now()).toBeLessThanOrEqual(240_000);
    // Outer retry layers must not stack another budget on top.
    expect(isRateLimitRetryExhausted(err)).toBe(true);
    expect(classifyStreamError(err)).toEqual({ transient: false, reason: "rate-limit-exhausted" });
  });

  it("fails fast when the provider asks for longer than the remaining budget", async () => {
    const c = clock();
    const run = vi.fn().mockRejectedValue(apiError(429, "x", { headers: { "retry-after": "600" } }));
    const err = await withProviderRateLimitRetry(run, { budgetMs: 240_000, now: c.now, sleep: c.sleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(600_000);
    expect(c.waits).toEqual([]);
  });

  it("passes every other error through untouched, on the first try", async () => {
    const c = clock();
    for (const err of [apiError(500, "boom"), apiError(429, "Insufficient balance"), new TypeError("fetch failed")]) {
      const run = vi.fn().mockRejectedValue(err);
      await expect(withProviderRateLimitRetry(run, { budgetMs: 240_000, now: c.now, sleep: c.sleep })).rejects.toBe(
        err,
      );
      expect(run).toHaveBeenCalledTimes(1);
    }
    expect(c.waits).toEqual([]);
  });

  it("budget 0 hands the original 429 to the generic retry path", async () => {
    process.env.MUONROI_RATE_LIMIT_RETRY_BUDGET_MS = "0";
    const err = apiError(429, "x");
    await expect(withProviderRateLimitRetry(vi.fn().mockRejectedValue(err))).rejects.toBe(err);
  });

  it("an abort during the wait ends it immediately", async () => {
    const ac = new AbortController();
    const run = vi.fn().mockRejectedValue(apiError(429, "x", { headers: { "retry-after": "30" } }));
    const p = withProviderRateLimitRetry(run, { budgetMs: 240_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(isProviderBackoffActive()).toBe(false);
  });
});
