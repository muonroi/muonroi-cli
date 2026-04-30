import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../src/types/index.js";
import { createHeadlessJsonlEmitter, type HeadlessWrites } from "../../src/headless/output.js";

function collectLines(writes: HeadlessWrites): string[] {
  if (!writes.stdout) return [];
  return writes.stdout.split("\n").filter((line) => line.trim().length > 0);
}

describe("headless golden test — JSONL output", () => {
  it("emits valid JSONL step_start / text / step_finish for simple prompt", () => {
    const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter("golden-test-1");
    const allLines: string[] = [];

    observer.onStepStart?.({ stepNumber: 1, timestamp: 1000 });

    const contentChunk: StreamChunk = { type: "content", content: "Hello world" };
    allLines.push(...collectLines(consumeChunk(contentChunk)));

    observer.onStepFinish?.({
      stepNumber: 1,
      timestamp: 2000,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    allLines.push(...collectLines(flush()));

    const events = allLines.map((line) => JSON.parse(line));

    expect(events.some((e) => e.type === "step_start" && e.stepNumber === 1)).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "Hello world")).toBe(true);
    expect(events.some((e) => e.type === "step_finish" && e.finishReason === "stop")).toBe(true);
    expect(events.every((e) => e.sessionID === "golden-test-1")).toBe(true);
  });

  it("emits tool_use events for tool call chunks", () => {
    const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter("golden-test-2");
    const allLines: string[] = [];

    const toolCallObj = {
      id: "tc1",
      type: "function" as const,
      function: { name: "read_file", arguments: '{"path":"test.ts"}' },
    };

    observer.onStepStart?.({ stepNumber: 1, timestamp: 1000 });

    const toolCallsChunk: StreamChunk = { type: "tool_calls", toolCalls: [toolCallObj] };
    allLines.push(...collectLines(consumeChunk(toolCallsChunk)));

    observer.onToolStart?.({ toolCall: toolCallObj, timestamp: 1500 });

    const toolResultChunk: StreamChunk = {
      type: "tool_result",
      toolCall: toolCallObj,
      toolResult: { success: true, output: "const x = 1;" },
    };
    observer.onToolFinish?.({
      toolCall: toolCallObj,
      toolResult: { success: true, output: "const x = 1;" },
      timestamp: 1800,
    });
    allLines.push(...collectLines(consumeChunk(toolResultChunk)));

    observer.onStepFinish?.({
      stepNumber: 1,
      timestamp: 2000,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    allLines.push(...collectLines(flush()));

    const events = allLines.map((line) => JSON.parse(line));

    // At least one tool_use event should be emitted
    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    expect(toolUseEvents.length).toBeGreaterThan(0);
  });

  it("handles empty session (no chunks)", () => {
    const { observer, flush } = createHeadlessJsonlEmitter("golden-test-3");
    const allLines: string[] = [];

    observer.onStepStart?.({ stepNumber: 1, timestamp: 1000 });
    observer.onStepFinish?.({
      stepNumber: 1,
      timestamp: 2000,
      finishReason: "stop",
      usage: {},
    });

    allLines.push(...collectLines(flush()));

    const events = allLines.map((line) => JSON.parse(line));

    expect(events.some((e) => e.type === "step_start")).toBe(true);
    expect(events.some((e) => e.type === "step_finish")).toBe(true);
    expect(events.every((e) => e.type !== "text")).toBe(true);
  });
});
