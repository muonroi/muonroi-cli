/**
 * feedbackEE durability: a verdict must never be lost or block the agent when
 * the brain is unreachable. Transient failures (network drop, 5xx) enqueue the
 * verdict offline and report `queued:true` (treated as success so the rating
 * ledger clears and the mandatory-rating gate cannot loop). Hard client errors
 * (4xx) surface as failures so the caller can correct the request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("./offline-queue.js", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
}));

vi.mock("./auth.js", () => ({
  loadEEAuthToken: async () => "tok",
  getCachedServerBaseUrl: () => "http://localhost:8082",
}));

// mirrorFeedbackLocally (success path) touches the filesystem — stub the log path
// away so the 200 case doesn't write to the real activity log.
vi.mock("../utils/ee-logger.js", () => ({
  logEeFailure: () => {},
  classifyEeError: () => "network",
}));

import { feedbackEE } from "./search.js";

const originalFetch = globalThis.fetch;

describe("feedbackEE durability", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    process.env.EXPERIENCE_ACTIVITY_LOG = "/dev/null";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.EXPERIENCE_ACTIVITY_LOG;
  });

  it("queues the verdict on a network error and reports success", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("The socket connection was closed unexpectedly");
    }) as unknown as typeof fetch;

    const r = await feedbackEE("abc123", "experience-behavioral", "followed");
    expect(r.ok).toBe(true);
    expect(r.queued).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({ endpoint: "/api/feedback" });
  });

  it("queues the verdict on a transient 5xx and reports success", async () => {
    globalThis.fetch = vi.fn(async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;

    const r = await feedbackEE("abc123", "experience-behavioral", "ignored");
    expect(r.ok).toBe(true);
    expect(r.queued).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT queue on a hard 4xx — surfaces the failure", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "unknown collection" }), { status: 400 }),
    ) as unknown as typeof fetch;

    const r = await feedbackEE("abc123", "bad-collection", "followed");
    expect(r.ok).toBe(false);
    expect(r.queued).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not queue on success", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ resolvedId: "abc123-full", verdict: "FOLLOWED" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const r = await feedbackEE("abc123", "experience-behavioral", "followed");
    expect(r.ok).toBe(true);
    expect(r.queued).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
