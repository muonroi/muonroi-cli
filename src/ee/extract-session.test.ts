/**
 * Unit + integration tests for extractSession module.
 *
 * Tests:
 *  1. Skip extraction when < 5 user messages
 *  2. Skip when exactly 4 user messages (mixed with other roles)
 *  3. Call client.extract() when >= 5 user messages
 *  4. Pass compacted transcript (not raw messages) to extract
 *  5. Pass AbortSignal.timeout(2000) to client.extract()
 *  6. Pass correct meta.source ("cli-exit" or "cli-clear")
 *  7. Swallow errors — never throws even if client.extract throws
 *  8. buildExtractTranscript truncates tool result bodies > 500 chars
 *  9. (integration) completes within 2s against stub with 3s latency
 * 10. Resumed session with 3+3 user messages (6 total) triggers extraction (D-07)
 */
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEEClient } from "./client.js";
import { setDefaultEEClient } from "./intercept.js";
import { startStubEEServer } from "../__test-stubs__/ee-server.js";
import { buildExtractTranscript, extractSession } from "./extract-session.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUserMsg(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as ModelMessage;
}

function makeAssistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as ModelMessage;
}

function makeToolResultMsg(result: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "x", content: [{ type: "text", text: result }] }],
  } as unknown as ModelMessage;
}

function fiveUserMessages(): ModelMessage[] {
  return [
    makeUserMsg("msg 1"),
    makeAssistantMsg("reply 1"),
    makeUserMsg("msg 2"),
    makeAssistantMsg("reply 2"),
    makeUserMsg("msg 3"),
    makeAssistantMsg("reply 3"),
    makeUserMsg("msg 4"),
    makeAssistantMsg("reply 4"),
    makeUserMsg("msg 5"),
    makeAssistantMsg("reply 5"),
  ];
}

// ─── Mocked client ────────────────────────────────────────────────────────────

describe("extractSession — unit (mocked client)", () => {
  const mockExtract = vi.fn().mockResolvedValue({ ok: true, mistakes: 0 });
  const mockClient = {
    extract: mockExtract,
    health: vi.fn(),
    intercept: vi.fn(),
    posttool: vi.fn(),
    routeModel: vi.fn(),
    coldRoute: vi.fn(),
    feedback: vi.fn(),
    touch: vi.fn(),
    routeFeedback: vi.fn(),
    promptStale: vi.fn(),
    stats: vi.fn(),
    graph: vi.fn(),
    timeline: vi.fn(),
    gates: vi.fn(),
    evolve: vi.fn(),
    sharePrinciple: vi.fn(),
    importPrinciple: vi.fn(),
    routeTask: vi.fn(),
    search: vi.fn(),
    user: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultEEClient(mockClient);
  });

  afterEach(() => {
    // Reset to null so other tests use real client
    setDefaultEEClient(null as any);
  });

  // Test 1: fewer than 5 user messages → skip
  it("Test 1: returns immediately when < 5 user messages", async () => {
    const messages: ModelMessage[] = [
      makeUserMsg("a"),
      makeAssistantMsg("b"),
      makeUserMsg("c"),
      makeAssistantMsg("d"),
    ];
    await extractSession(messages, "/proj", "cli-exit");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  // Test 2: exactly 4 user messages mixed with other roles → skip
  it("Test 2: skips with exactly 4 user messages mixed with assistant/tool", async () => {
    const messages: ModelMessage[] = [
      makeUserMsg("u1"),
      makeAssistantMsg("a1"),
      makeToolResultMsg("result1"),
      makeUserMsg("u2"),
      makeAssistantMsg("a2"),
      makeUserMsg("u3"),
      makeAssistantMsg("a3"),
      makeUserMsg("u4"),
    ];
    await extractSession(messages, "/proj", "cli-exit");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  // Test 3: 5+ user messages → call extract
  it("Test 3: calls client.extract() when >= 5 user messages", async () => {
    await extractSession(fiveUserMessages(), "/proj", "cli-exit");
    expect(mockExtract).toHaveBeenCalledOnce();
  });

  // Test 4: passes compacted transcript (string) not raw messages
  it("Test 4: passes compacted transcript string to extract", async () => {
    await extractSession(fiveUserMessages(), "/proj", "cli-exit");
    const call = mockExtract.mock.calls[0];
    expect(typeof call[0].transcript).toBe("string");
    expect(call[0].transcript.length).toBeGreaterThan(0);
    // Should NOT be JSON of raw messages array
    expect(call[0].transcript).not.toMatch(/^\[/);
  });

  // Test 5: passes AbortSignal.timeout(2000) as second arg
  it("Test 5: passes AbortSignal.timeout(2000) to client.extract()", async () => {
    await extractSession(fiveUserMessages(), "/proj", "cli-exit");
    const call = mockExtract.mock.calls[0];
    const signal = call[1] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // The signal should not be aborted immediately (we have 2s budget)
    expect(signal.aborted).toBe(false);
  });

  // Test 6: passes correct meta.source
  it("Test 6a: passes meta.source='cli-exit' correctly", async () => {
    await extractSession(fiveUserMessages(), "/proj", "cli-exit");
    expect(mockExtract.mock.calls[0][0].meta?.source).toBe("cli-exit");
  });

  it("Test 6b: passes meta.source='cli-clear' correctly", async () => {
    await extractSession(fiveUserMessages(), "/proj", "cli-clear");
    expect(mockExtract.mock.calls[0][0].meta?.source).toBe("cli-clear");
  });

  // Test 7: swallows errors — never throws
  it("Test 7: swallows errors from client.extract() and never throws", async () => {
    mockExtract.mockRejectedValueOnce(new Error("EE server down"));
    await expect(extractSession(fiveUserMessages(), "/proj", "cli-exit")).resolves.toBeUndefined();
  });

  // Test 10: resumed session (3 prior + 3 new = 6 total) triggers extraction (D-07)
  it("Test 10: resumed session with 6 total user msgs triggers extraction", async () => {
    // Simulate: 3 prior session user msgs + 3 new session user msgs = 6 total
    const messages: ModelMessage[] = [
      makeUserMsg("prior 1"),
      makeAssistantMsg("prior reply 1"),
      makeUserMsg("prior 2"),
      makeAssistantMsg("prior reply 2"),
      makeUserMsg("prior 3"),
      makeAssistantMsg("prior reply 3"),
      makeUserMsg("new 1"),
      makeAssistantMsg("new reply 1"),
      makeUserMsg("new 2"),
      makeAssistantMsg("new reply 2"),
      makeUserMsg("new 3"),
      makeAssistantMsg("new reply 3"),
    ];
    await extractSession(messages, "/proj", "cli-exit", "session-123");
    expect(mockExtract).toHaveBeenCalledOnce();
    expect(mockExtract.mock.calls[0][0].meta?.sessionId).toBe("session-123");
  });
});

// ─── buildExtractTranscript unit tests ───────────────────────────────────────

describe("buildExtractTranscript", () => {
  // Test 8: truncates tool result bodies > 500 chars
  it("Test 8: truncates tool result bodies longer than 500 chars", () => {
    const longResult = "x".repeat(1000);
    const messages: ModelMessage[] = [
      makeUserMsg("question"),
      makeAssistantMsg("answer"),
      makeToolResultMsg(longResult),
    ];
    const output = buildExtractTranscript(messages);
    expect(output).toContain("[truncated]");
    // The output should be shorter than the raw concatenation would be
    expect(output.length).toBeLessThan(longResult.length + 200);
  });

  it("does not truncate tool results <= 500 chars", () => {
    const shortResult = "y".repeat(499);
    const messages: ModelMessage[] = [
      makeUserMsg("question"),
      makeAssistantMsg("answer"),
      makeToolResultMsg(shortResult),
    ];
    const output = buildExtractTranscript(messages);
    expect(output).not.toContain("[truncated]");
  });
});

// ─── Integration test (real stub server) ─────────────────────────────────────

describe("extractSession — integration (real stub server)", () => {
  it("Test 9: completes within 2s against stub with 3s latency (D-04)", async () => {
    // Start stub with 3s artificial latency
    const stub = await startStubEEServer({ latencyMs: 3000 });
    const client = createEEClient({ baseUrl: `http://127.0.0.1:${stub.port}` });
    setDefaultEEClient(client as any);

    try {
      const start = Date.now();
      await extractSession(fiveUserMessages(), "/proj", "cli-exit");
      const elapsed = Date.now() - start;

      // AbortSignal.timeout(2000) fires, error is swallowed, function returns
      expect(elapsed).toBeLessThan(2500);
    } finally {
      setDefaultEEClient(null as any);
      await stub.stop();
    }
  });
});
