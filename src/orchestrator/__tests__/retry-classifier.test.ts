import { describe, expect, it } from "vitest";
import { classifyStreamError } from "../retry-classifier.js";
import { STALL_ABORT_REASON } from "../stall-watchdog.js";

describe("classifyStreamError", () => {
  it("classifies ECONNREFUSED as transient", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies ETIMEDOUT as transient", () => {
    const err = new Error("request failed: ETIMEDOUT");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies 'fetch failed' TypeError as transient", () => {
    const err = new TypeError("fetch failed");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 502 as transient", () => {
    const err = Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 503 as transient", () => {
    const err = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 504 as transient", () => {
    const err = Object.assign(new Error("Gateway Timeout"), { statusCode: 504 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 429 as transient", () => {
    const err = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 401 as NOT transient", () => {
    const err = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });

  it("classifies HTTP 400 as NOT transient", () => {
    const err = Object.assign(new Error("Bad Request"), { statusCode: 400 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });

  it("classifies HTTP 403 as NOT transient", () => {
    const err = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });

  it("classifies HTTP 422 as NOT transient", () => {
    const err = Object.assign(new Error("Unprocessable Entity"), { statusCode: 422 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });

  it("classifies AbortError (user cancel) as NOT transient", () => {
    const err = new DOMException("Aborted", "AbortError");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });

  it("classifies a provider-stall watchdog abort as NOT transient (no retry-storm)", () => {
    // The stall watchdog aborts with DOMException(STALL_ABORT_REASON, "TimeoutError").
    // It must NOT be retried — a stalled provider just stalls again, burning
    // another full timeout of silence. Distinct from a generic AbortSignal.timeout().
    const err = new DOMException(STALL_ABORT_REASON, "TimeoutError");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
    expect(result.reason).toBe("provider-stall");
  });

  it("classifies TimeoutError (AbortSignal.timeout) as transient", () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("finds transient code in nested cause chain", () => {
    const inner = new Error("connect ECONNRESET");
    const outer = Object.assign(new Error("Request failed"), { cause: inner });
    const result = classifyStreamError(outer);
    expect(result.transient).toBe(true);
    expect(result.reason).toMatch(/^cause:/);
  });

  it("classifies 'socket hang up' as transient", () => {
    const err = new Error("socket hang up");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies 'Unable to connect' as transient", () => {
    const err = new Error("Cannot connect to API: Unable to connect. Is the computer able to access the url?");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 500 as transient", () => {
    const err = Object.assign(new Error("Internal Server Error"), { statusCode: 500 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies HTTP 408 as transient", () => {
    const err = Object.assign(new Error("Request Timeout"), { statusCode: 408 });
    const result = classifyStreamError(err);
    expect(result.transient).toBe(true);
  });

  it("classifies unknown error as NOT transient", () => {
    const err = new Error("some weird unexpected error");
    const result = classifyStreamError(err);
    expect(result.transient).toBe(false);
  });
});
