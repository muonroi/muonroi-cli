/**
 * Integration tests for the cleanup -> extractSession -> /api/extract pipeline.
 *
 * EXTRACT-01: Agent.cleanup() calls extractSession which hits /api/extract on stub server
 * EXTRACT-03: Agent.cleanup() completes within 2.5s even when stub has 3s latency
 * D-05:       Agent.cleanup() completes normally when EE server is unreachable
 *
 * These tests call extractSession directly (the same function wired in Agent.cleanup)
 * to validate the full HTTP pipeline without needing a real Agent instance.
 */
import type { ModelMessage } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { createEEClient } from "../ee/client.js";
import { setDefaultEEClient } from "../ee/intercept.js";
import { extractSession } from "../ee/extract-session.js";
import { startStubEEServer } from "../__test-stubs__/ee-server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestMessages(userCount: number): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < userCount; i++) {
    msgs.push({ role: "user", content: `Message ${i + 1}` } as unknown as ModelMessage);
    msgs.push({ role: "assistant", content: `Response ${i + 1}` } as unknown as ModelMessage);
  }
  return msgs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cleanup -> extractSession -> /api/extract integration", () => {
  // Stub server started fresh per test via beforeEach / per-test setup
  // afterAll cleanup is handled within each test using try/finally

  it("Test 1 (EXTRACT-01): extractSession hits /api/extract on stub server with correct source", async () => {
    const stub = await startStubEEServer();
    const client = createEEClient({ baseUrl: `http://127.0.0.1:${stub.port}` });
    setDefaultEEClient(client as any);

    try {
      // 6 user messages — exceeds 5-message threshold
      await extractSession(buildTestMessages(6), "/tmp/test-project", "cli-exit", "session-abc");

      expect(stub.calls.extract.length).toBe(1);
      expect(stub.calls.extract[0].meta?.source).toBe("cli-exit");
      expect(stub.calls.extract[0].projectPath).toBe("/tmp/test-project");
    } finally {
      setDefaultEEClient(null as any);
      await stub.stop();
    }
  });

  it("Test 2 (EXTRACT-03): extractSession completes within 2.5s against 3s-latency stub", async () => {
    const stub = await startStubEEServer({ latencyMs: 3000 });
    const client = createEEClient({ baseUrl: `http://127.0.0.1:${stub.port}` });
    setDefaultEEClient(client as any);

    try {
      const start = Date.now();
      // Should complete quickly because AbortSignal.timeout(2000) fires
      await extractSession(buildTestMessages(6), "/tmp/test-project", "cli-exit");
      const elapsed = Date.now() - start;

      // AbortSignal(2000ms) fires and error is swallowed — must complete in < 2500ms
      expect(elapsed).toBeLessThan(2500);
      // Request was aborted before server responded — no extract calls logged
      expect(stub.calls.extract.length).toBe(0);
    } finally {
      setDefaultEEClient(null as any);
      await stub.stop();
    }
  });

  it("Test 3 (D-05): extractSession resolves without throwing when EE server is unreachable", async () => {
    // Point at port 1 — nothing listening there
    const client = createEEClient({ baseUrl: "http://127.0.0.1:1" });
    setDefaultEEClient(client as any);

    try {
      // Must resolve (not throw) even when server is unreachable
      await expect(
        extractSession(buildTestMessages(6), "/tmp/test-project", "cli-exit"),
      ).resolves.toBeUndefined();
    } finally {
      setDefaultEEClient(null as any);
    }
  });
});
