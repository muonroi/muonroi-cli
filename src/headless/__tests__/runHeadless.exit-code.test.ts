import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../orchestrator/orchestrator";
import type { StreamChunk } from "../../types/index";
import { runHeadless } from "../output";

/** Build a minimal mock Agent whose processMessage yields controlled chunks. */
function mockAgent(chunks: StreamChunk[]): Agent {
  return {
    getSessionId: () => "test-session",
    processMessage: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      for (const c of chunks) yield c;
    }),
    cleanup: vi.fn(async () => {}),
    respondToCouncilQuestion: vi.fn(),
    respondToCouncilPreflight: vi.fn(),
    getModel: vi.fn(),
  } as unknown as Agent;
}

describe("runHeadless exit-code", () => {
  it("returns exitCode 0 when the agent produces answer content", async () => {
    const agent = mockAgent([
      { type: "content", content: "Hello from headless\n" },
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "hi", "text");
    expect(exitCode).toBe(0);
    expect(hasAnyAnswer).toBe(true);
  });

  it("returns exitCode 1 when the agent produces no answer content (tool-only turn)", async () => {
    const agent = mockAgent([
      { type: "tool_calls", toolCalls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { type: "tool_result", toolCall: { id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }, toolResult: { success: true, output: "ok", error: "" } },
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "do a thing", "text");
    expect(exitCode).toBe(1);
    expect(hasAnyAnswer).toBe(false);
  });

  it("returns exitCode 0 on error-after-answer (flush succeeded, then a subsequent error occurs)", async () => {
    // Simulate: content is produced (hasAnswer=true), then an error chunk arrives.
    const agent = mockAgent([
      { type: "content", content: "partial answer\n" },
      { type: "error", content: "something broke" },
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "do it", "text");
    expect(hasAnyAnswer).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("returns exitCode 0 in json format when content is produced", async () => {
    const agent = mockAgent([
      { type: "content", content: "json answer\n" },
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "json query", "json", "sess-1");
    expect(exitCode).toBe(0);
    expect(hasAnyAnswer).toBe(true);
  });

  it("returns exitCode 1 in json format when no content is produced", async () => {
    const agent = mockAgent([
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "silent query", "json", "sess-2");
    expect(exitCode).toBe(1);
    expect(hasAnyAnswer).toBe(false);
  });

  it("returns exitCode 0 on structured_response (respond_* terminal answer)", async () => {
    const agent = mockAgent([
      {
        type: "structured_response",
        structuredResponse: { taskType: "answer", data: { text: "Terminal answer" } },
      },
      { type: "done" },
    ]);
    const { exitCode, hasAnyAnswer } = await runHeadless(agent, "ask", "text");
    expect(exitCode).toBe(0);
    expect(hasAnyAnswer).toBe(true);
  });
});
