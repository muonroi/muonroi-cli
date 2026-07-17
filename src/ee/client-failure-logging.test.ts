/**
 * client-failure-logging.test.ts
 *
 * ee-logger.ts documents the contract in its own header: "Every silent
 * Experience Engine catch site routes through `logEeFailure`". client.ts imports
 * logEeFailure and honours that for posttool/feedback/noiseFeedback/touch — but
 * health() and recall(), the two calls an agent actually depends on, were bare
 * catches.
 *
 * That cost real time. On 2026-07-17 the EE brain was blocking its event loop for
 * ~3s per request (a 307MB read-modify-write on the routing hot path). What the
 * agent saw was `ee_health {"ok":false,"status":0}` and `[ee_unavailable]` — no
 * error name, no status, no elapsed time. Every hypothesis (429? auth? server
 * down? network?) looked equally consistent with that output, and the true cause
 * was only found by instrumenting the SERVER. `recall()` is worse than health():
 * `if (!resp.ok) return null` collapses 429, 401 and 500 into the exact same null
 * a timeout produces, so the one signal that would have refuted the 429 theory
 * immediately was the one being discarded.
 *
 * These tests pin the diagnosis surface, not the degrade behaviour: the fallbacks
 * (`{ok:false,status:0}` / `null`) must stay EXACTLY as they are — callers depend
 * on them — while the cause becomes visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as eeLogger from "../utils/ee-logger.js";
import { createEEClient } from "./client.js";

function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EEClient.health — failure cause must be visible", () => {
  it("logs the underlying error instead of swallowing it, and still degrades to {ok:false,status:0}", async () => {
    const mockFetch = vi.fn().mockRejectedValue(timeoutError());
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    const result = await ee.health();

    expect(result).toEqual({ ok: false, status: 0 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [source, kind] = logSpy.mock.calls[0];
    expect(source).toBe("client.health");
    expect(kind).toBe("timeout");
  });

  it("classifies a non-timeout failure as error, not timeout", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    const result = await ee.health();

    expect(result).toEqual({ ok: false, status: 0 });
    expect(logSpy.mock.calls[0][1]).toBe("error");
  });

  it("a healthy call logs nothing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    expect(await ee.health()).toEqual({ ok: true, status: 200 });
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("EEClient.recall — HTTP status must survive the null", () => {
  it("preserves the status on a non-ok response instead of collapsing it into null", async () => {
    // The 429 case specifically: the user's first hypothesis for this incident was
    // rate limiting. `if (!resp.ok) return null` made that unfalsifiable from the
    // client. It was refuted only by reading the server source.
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    const result = await ee.recall("how do I restart the server");

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [source, kind, , extra] = logSpy.mock.calls[0];
    expect(source).toBe("client.recall");
    expect(kind).toBe("error");
    expect((extra as { status?: number })?.status).toBe(429);
  });

  it("distinguishes 401 from 429 — they are not the same failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    expect(await ee.recall("q")).toBeNull();
    expect((logSpy.mock.calls[0][3] as { status?: number })?.status).toBe(401);
  });

  it("logs a timeout as timeout, with no status (there was no response)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(timeoutError());
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    expect(await ee.recall("q")).toBeNull();
    const [source, kind, , extra] = logSpy.mock.calls[0];
    expect(source).toBe("client.recall");
    expect(kind).toBe("timeout");
    expect((extra as { status?: number })?.status).toBeUndefined();
  });

  it("a successful recall logs nothing and returns the payload", async () => {
    const payload = { text: "hint", entries: [], count: 0, query: "q" };
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    expect(await ee.recall("q")).toEqual(payload);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
