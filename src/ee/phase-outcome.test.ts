import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetPhaseOutcomeState,
  fireAndForgetPhaseOutcome,
  firePhaseOutcome,
  type PhaseOutcomePayload,
} from "./phase-outcome.js";

function makeStubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init ?? {}));
  };
}

const samplePayload: PhaseOutcomePayload = {
  sessionId: "sid-1",
  phaseName: "implement",
  outcome: "pass",
  toolEventIds: [{ collection: "code", pointId: "p1" }],
};

describe("firePhaseOutcome", () => {
  beforeEach(() => _resetPhaseOutcomeState());
  afterEach(() => _resetPhaseOutcomeState());

  it("posts to /api/phase-outcome with JSON body and returns parsed result", async () => {
    let receivedUrl = "";
    let receivedBody = "";
    const stubFetch = makeStubFetch(async (url, init) => {
      receivedUrl = url;
      receivedBody = String(init.body ?? "");
      return new Response(JSON.stringify({ ok: true, applied: 1, skipped: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await firePhaseOutcome(samplePayload, {
      baseUrl: "http://x:1",
      fetchImpl: stubFetch as typeof fetch,
    });
    expect(receivedUrl).toBe("http://x:1/api/phase-outcome");
    expect(JSON.parse(receivedBody).sessionId).toBe("sid-1");
    expect(result).toEqual({ ok: true, applied: 1, skipped: 0 });
  });

  it("returns null when server responds 404 (endpoint disabled)", async () => {
    const stubFetch = makeStubFetch(async () => new Response("not found", { status: 404 }));
    const result = await firePhaseOutcome(samplePayload, {
      fetchImpl: stubFetch as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null and warns once on non-404 error", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const stubFetch = makeStubFetch(async () => new Response("boom", { status: 500 }));
      const r1 = await firePhaseOutcome(samplePayload, {
        fetchImpl: stubFetch as typeof fetch,
      });
      const r2 = await firePhaseOutcome(samplePayload, {
        fetchImpl: stubFetch as typeof fetch,
      });
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it("returns null on network error", async () => {
    const stubFetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
    const result = await firePhaseOutcome(samplePayload, {
      fetchImpl: stubFetch,
    });
    expect(result).toBeNull();
  });

  it("includes Authorization header when authToken provided", async () => {
    let authHeader: string | null = null;
    const stubFetch = makeStubFetch(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      authHeader = headers.Authorization;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await firePhaseOutcome(samplePayload, {
      fetchImpl: stubFetch as typeof fetch,
      authToken: "secret-token",
    });
    expect(authHeader).toBe("Bearer secret-token");
  });
});

describe("fireAndForgetPhaseOutcome", () => {
  beforeEach(() => _resetPhaseOutcomeState());

  it("does not throw on rejection", () => {
    const stubFetch = (() => Promise.reject(new Error("nope"))) as typeof fetch;
    expect(() => {
      fireAndForgetPhaseOutcome(samplePayload, { fetchImpl: stubFetch });
    }).not.toThrow();
  });
});
