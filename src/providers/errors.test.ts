/**
 * Tests for src/providers/errors.ts
 * Verifies normalizeError maps various error shapes to the 5 NormalizedErrorKind values.
 */
import { describe, expect, it } from "vitest";
import { normalizeError } from "./errors.js";

describe("normalizeError", () => {
  it("maps RateLimitError name to rate_limit", () => {
    const err = Object.assign(new Error("Rate limit exceeded"), { name: "RateLimitError", status: 429 });
    const n = normalizeError(err);
    expect(n.kind).toBe("rate_limit");
    expect(n.status).toBe(429);
  });

  it("maps status 429 to rate_limit even without name", () => {
    const err = Object.assign(new Error("Too many requests"), { status: 429 });
    const n = normalizeError(err);
    expect(n.kind).toBe("rate_limit");
  });

  it("maps AuthenticationError name to auth", () => {
    const err = Object.assign(new Error("Invalid API key"), { name: "AuthenticationError", status: 401 });
    const n = normalizeError(err);
    expect(n.kind).toBe("auth");
    expect(n.status).toBe(401);
  });

  it("maps status 403 to auth", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    const n = normalizeError(err);
    expect(n.kind).toBe("auth");
  });

  it("maps content filter message to content_filter", () => {
    const err = new Error("Content blocked by safety filter");
    const n = normalizeError(err);
    expect(n.kind).toBe("content_filter");
  });

  it("maps policy violation to content_filter", () => {
    const err = new Error("This request violates our usage policy");
    const n = normalizeError(err);
    expect(n.kind).toBe("content_filter");
  });

  it("maps status 500 to server_error", () => {
    const err = Object.assign(new Error("Internal server error"), { status: 500 });
    const n = normalizeError(err);
    expect(n.kind).toBe("server_error");
  });

  it("maps status 502 to server_error", () => {
    const err = Object.assign(new Error("Bad gateway"), { status: 502 });
    const n = normalizeError(err);
    expect(n.kind).toBe("server_error");
  });

  it("maps unknown error to unknown", () => {
    const err = new Error("Something weird happened");
    const n = normalizeError(err);
    expect(n.kind).toBe("unknown");
  });

  it("handles non-Error input", () => {
    const n = normalizeError("string error");
    expect(n.kind).toBe("unknown");
    expect(n.message).toBe("string error");
  });

  it("preserves provider_message", () => {
    const err = new Error("Quota exceeded");
    const n = normalizeError(err);
    expect(n.provider_message).toBe("Quota exceeded");
  });
});
