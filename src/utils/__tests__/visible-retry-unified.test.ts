/**
 * isRetryableError — unified-classifier contract.
 *
 * Prior to this unification, `visible-retry.ts:isRetryableError` (council path)
 * and `retry-classifier.ts:classifyStreamError` (orchestrator stream path) were
 * two parallel classifiers that drifted. The bab91d29 bug class — a socket-drop
 * that main chat retried but council burned 6 attempts on — was the symptom.
 *
 * These tests pin the contract that `isRetryableError` now delegates to the
 * single source of truth. Any future drift surfaces as a test failure here
 * rather than as a production bug.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetProviderThinkingDegrade, isProviderThinkingDegraded } from "../../providers/strategies/thinking-mode.js";
import { isRetryableError, withVisibleRetry } from "../visible-retry.js";

afterEach(() => _resetProviderThinkingDegrade());

/** Build a provider-style error with statusCode + message (the APICallError shape). */
function apiError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe("isRetryableError — 1210 one-shot degrade parity (was the council gap)", () => {
  it("FIRST z.ai 1210 'Invalid API parameter' is retryable AND flips the degrade latch", () => {
    // This is the central contract: going through classifyStreamError (not
    // copying its regex) is load-bearing — the latch MUST fire here, otherwise
    // the retry would rebuild the same rejected body and 1210 again.
    const err = apiError(400, "Invalid API parameter, please check the documentation.");
    expect(isRetryableError(err)).toBe(true);
    expect(isProviderThinkingDegraded()).toBe(true);
  });

  it("SECOND 1210 (after degrade latched) is NOT retryable — no retry storm", () => {
    const err = apiError(400, "Invalid API parameter");
    expect(isRetryableError(err)).toBe(true); // first
    expect(isRetryableError(err)).toBe(false); // second — cause beyond client fix
  });

  it("opencode-go 'Upstream request failed' 400 also retryable once", () => {
    const err = apiError(400, "Error from provider (Console Go): Upstream request failed");
    expect(isRetryableError(err)).toBe(true);
  });

  it("'unexpected end of JSON input' 400 (truncated tool args) retryable once", () => {
    const err = apiError(400, "error parsing parameters: unexpected end of JSON input");
    expect(isRetryableError(err)).toBe(true);
  });

  it("a generic non-1210 400 stays non-retryable", () => {
    // Belt-and-suspenders: tightening the 1210 branch must NOT loosen the safe
    // default for ordinary bad-request errors (auth, validation, content filter).
    expect(isRetryableError(apiError(400, "Bad Request: malformed field 'foo'"))).toBe(false);
  });
});

describe("isRetryableError — network patterns (council path now matches full set)", () => {
  // The bab91d29 gap: "socket connection was closed unexpectedly" was retried
  // on main chat but not council. Now unified.
  it.each([
    "The socket connection was closed unexpectedly",
    "socket hang up",
    "fetch failed",
    "read ECONNRESET",
    "Premature close",
    "terminated",
    "stream closed",
    "connection error",
  ])("retries message: %s", (message) => {
    expect(isRetryableError(new Error(message))).toBe(true);
  });

  it("retries a bare errno `code` field with no message hint", () => {
    // undici/node-fetch attach the raw errno to error.code while the message is
    // a generic "request failed". The council path historically checked `code`
    // directly; preserve that under the unified classifier.
    const err = Object.assign(new Error("request failed"), { code: "ECONNRESET" });
    expect(isRetryableError(err)).toBe(true);
  });
});

describe("isRetryableError — non-transient defaults preserved", () => {
  it("AbortError (user cancel) NOT retryable", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isRetryableError(err)).toBe(false);
  });

  it.each([401, 403, 422])("HTTP %s NOT retryable", (statusCode) => {
    expect(isRetryableError(apiError(statusCode, "fail"))).toBe(false);
  });

  it("HTTP 401 with 'connection' in message still NOT retryable", () => {
    // Regression guard: don't let the network regex override an explicit auth
    // status — retrying 401 burns money to fail identically.
    const err = apiError(401, "connection closed: unauthorized");
    expect(isRetryableError(err)).toBe(false);
  });

  it("malformed tool/function name NOT retryable", () => {
    expect(isRetryableError(new Error("Invalid function name: foo_bar"))).toBe(false);
  });
});

describe("isRetryableError — cause recursion (previously missing on council path)", () => {
  it("error wrapped in another error's cause still classified", () => {
    // Main-chat path recursed one level into `cause`; the old council
    // isRetryableError did not. Wrappers (fetch, proxies) often nest.
    const inner = new Error("ECONNRESET");
    const outer = new Error("wrapper", { cause: inner });
    expect(isRetryableError(outer)).toBe(true);
  });
});

describe("isRetryableError — provider-stall watchdog abort", () => {
  it("DOMException provider-stall NOT retryable", () => {
    // The watchdog aborts a stalled stream with DOMException("provider-stall",
    // "TimeoutError"). Retrying just stalls again — must NOT be classified
    // transient. (Council path used to retry these — burned budget.)
    const err = new DOMException("provider-stall", "TimeoutError");
    expect(isRetryableError(err)).toBe(false);
  });
});

describe("withVisibleRetry — 1210 only retries once despite 6-attempt budget", () => {
  // withVisibleRetry defaults to 6 attempts. The one-shot degrade latch MUST
  // short-circuit after the first 1210 retry — otherwise council burns all 6
  // attempts on a dead provider (the bug class f58d2457 / bab91d29 addressed).
  it("stops after the second 1210 (latched non-transient), not 6 attempts", async () => {
    const err = apiError(400, "Invalid API parameter");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withVisibleRetry(fn)).rejects.toThrow("Invalid API parameter");
    // First call flips the latch + transient. Second call is non-transient → break.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
