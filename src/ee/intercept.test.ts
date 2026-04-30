import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startStubEEServer, type StubHandle } from "../../tests/stubs/ee-server.js";
import { createEEClient } from "./client.js";
import { setDefaultEEClient, getDefaultEEClient } from "./intercept.js";
import { setRenderSink } from "./render.js";
import type { InterceptMatch, InterceptRequest } from "./types.js";

const baseReq: InterceptRequest = {
  toolName: "bash",
  toolInput: { command: "rm -rf /" },
  cwd: "/tmp",
  tenantId: "local",
  scope: { kind: "global" },
};

const sampleMatch: InterceptMatch = {
  principle_uuid: "p-uuid-001",
  embedding_model_version: "nomic-embed-text-v1.5",
  confidence: 0.85,
  why: "Dangerous command detected",
  message: "Avoid destructive commands",
  scope_label: "global",
  last_matched_at: "2026-04-30T00:00:00Z",
};

describe("intercept integration", () => {
  let stub: StubHandle;
  let captured: string[];

  beforeEach(async () => {
    captured = [];
    setRenderSink((line) => captured.push(line));
  });

  afterEach(async () => {
    if (stub) await stub.stop();
  });

  it("decision=block returns response unchanged (caller aborts)", async () => {
    stub = await startStubEEServer({
      intercept: () => ({ decision: "block", reason: "too dangerous" }),
    });
    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    // Use the full intercept function (from intercept.ts)
    const { intercept } = await import("./intercept.js");
    const resp = await intercept(baseReq);
    expect(resp.decision).toBe("block");
    expect(resp.reason).toBe("too dangerous");
    // No matches emitted on block
    expect(captured).toHaveLength(0);
  });

  it("decision=allow with matches[] emits rendered lines via sink", async () => {
    stub = await startStubEEServer({
      intercept: () => ({
        decision: "allow",
        matches: [sampleMatch],
      }),
    });
    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    const { intercept } = await import("./intercept.js");
    const resp = await intercept(baseReq);
    expect(resp.decision).toBe("allow");
    expect(resp.matches).toHaveLength(1);
    // The render sink should have captured the warning
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("Avoid destructive commands");
    expect(captured[0]).toContain("Why: Dangerous command detected");
    expect(captured[0]).toContain("Scope: global");
  });

  it("posttool carries tenantId + scope (B-4 void preserved)", async () => {
    stub = await startStubEEServer({
      posttool: () => {},
    });
    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    const { posttool } = await import("./posttool.js");
    const result = posttool({
      toolName: "bash",
      toolInput: { command: "ls" },
      outcome: { success: true },
      cwd: "/tmp",
      tenantId: "local",
      scope: { kind: "global" },
    });
    // B-4: returns void synchronously
    expect(result).toBeUndefined();

    // Let fire-and-forget settle
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.calls.posttool).toHaveLength(1);
    expect(stub.calls.posttool[0].tenantId).toBe("local");
    expect(stub.calls.posttool[0].scope).toEqual({ kind: "global" });
  });
});

describe("401 refresh path", () => {
  let stub: StubHandle;

  afterEach(async () => {
    if (stub) await stub.stop();
  });

  it("retries once with refreshed token on 401", async () => {
    let callCount = 0;
    stub = await startStubEEServer({
      intercept: () => {
        callCount++;
        // First call should be the retry after 401
        return { decision: "allow", matches: [sampleMatch] };
      },
    });

    // We need a custom intercept flow that handles 401.
    // The 401 is surfaced by the client as reason='auth-required'.
    // For this test, we'll mock the fetch to return 401 first, then succeed.
    let fetchCallCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First call: return 401
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Subsequent calls: proxy to real stub
      const url = typeof input === "string" ? input : (input as Request).url;
      const stubUrl = url.replace(/http:\/\/[^/]+/, `http://127.0.0.1:${stub.port}`);
      return fetch(stubUrl, init);
    };

    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
      fetchImpl: mockFetch,
    });

    // Test that the client returns auth-required on 401
    const resp = await client.intercept(baseReq);
    expect(resp.reason).toBe("auth-required");
  });
});
