/**
 * N3(b) — integration proof that the failing-tool-loop guard terminates a REAL
 * `streamText` sub-agent turn, that the abort actually stops the child, and
 * that the reason survives into the ToolResult the sprint reads.
 *
 * The unit test (`tool-failure-loop.test.ts`) pins the predicate. This one
 * drives `StreamRunner` over the real AI-SDK multi-step loop with a mock model
 * that keeps emitting a tool call whose tool always fails — the exact shape
 * measured in session e28336959a62, where `read_file` returned the same error
 * 12x (and later 8x) with DIFFERENT arguments each time, so the existing
 * `tool-repetition-detector` (keyed on toolName + hash(input)) never fired and
 * the no-forward-progress timer was re-armed by every failing call.
 */

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMockModel, type StreamChunks } from "../agent-harness/mock-model.js";
import type { TaskRequest } from "../types/index.js";
import { type PreparedSubAgentCall, StreamRunner, type StreamRunnerDeps } from "./stream-runner.js";

/** One AI-SDK round that calls `read_file` with a DIFFERENT path each time. */
function failingReadRound(i: number): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-${i}`,
      toolName: "read_file",
      input: JSON.stringify({ file_path: `src/generated/file-${i}.ts` }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
}

function makeDeps(): StreamRunnerDeps {
  return {
    resolveModelForTask: vi.fn(),
    getModelId: () => "mock-model",
    getProviderId: () => "mock",
    getBash: vi.fn(),
    getMaxToolRounds: () => 50,
    getMaxTokens: () => 4096,
    isBatchApiEnabled: () => false,
    getCrossTurnDedup: () => undefined,
    getReadBudget: () => undefined,
    recordUsage: vi.fn(),
    setCurrentCallId: vi.fn(),
    setLastProviderOptionsShape: vi.fn(),
    getSessionId: () => undefined,
    runTaskRequestBatch: vi.fn(),
  } as unknown as StreamRunnerDeps;
}

const REQUEST: TaskRequest = { agent: "general", description: "sprint impl", prompt: "go" };

function prepare(opts: { rounds: number; toolExecute: (input: { file_path: string }) => Promise<string> }) {
  const model = createMockModel({
    // Each doStream call gets its own round, so the tool arguments differ every
    // iteration — the condition that defeated the old detector.
    stream: Array.from({ length: opts.rounds }, (_, i) => failingReadRound(i)),
  }).model;

  const prepared = {
    request: REQUEST,
    agentKey: "general",
    childMode: "yolo",
    childBash: {},
    childRuntime: {
      model,
      modelId: "mock-model",
      modelInfo: { id: "mock-model", provider: "deepseek", contextWindow: 128_000 },
    },
    childSystem: "you are a sub-agent",
    childMessages: [{ role: "user", content: "go" }],
    childTools: {
      read_file: tool({
        description: "read a file",
        inputSchema: z.object({ file_path: z.string() }),
        execute: async (input: { file_path: string }) => opts.toolExecute(input),
      }),
    },
    initialDetail: "starting",
    lastActivity: "starting",
    maxSteps: 40,
    useBatchApi: false,
  } as unknown as PreparedSubAgentCall;

  const runner = new StreamRunner(makeDeps());
  // Bypass provider/bash/MCP resolution — this spec is about the drain loop,
  // and `run()` is still the real code path (its ToolResult mapping included).
  (runner as unknown as { setup: () => Promise<unknown> }).setup = async () => ({ kind: "prepared", prepared });
  return runner;
}

/** The verbatim error observed 12x then 8x in session e28336959a62. */
const OBSERVED_ERR = 'ERROR: Failed to read file: The "path" property must be of type string, got undefined';

function withThreshold<T>(n: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MUONROI_TOOL_FAILURE_LOOP_N;
  process.env.MUONROI_TOOL_FAILURE_LOOP_N = n;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.MUONROI_TOOL_FAILURE_LOOP_N;
    else process.env.MUONROI_TOOL_FAILURE_LOOP_N = prev;
  });
}

describe("StreamRunner — failing-tool-loop guard", () => {
  it("terminates the turn at N and reports the reason as a failed ToolResult", async () => {
    await withThreshold("8", async () => {
      let calls = 0;
      const runner = prepare({
        rounds: 40,
        toolExecute: async () => {
          calls += 1;
          return OBSERVED_ERR;
        },
      });
      const result = await runner.run(REQUEST);

      expect(result.success).toBe(false);
      expect(result.output).toContain("tool-failure-loop abort");
      expect(result.output).toContain("read_file");
      expect(result.output).toContain("8 times in a row");
      // The reason must survive into the field the sprint's resolver reads.
      expect(result.error).toContain("tool-failure-loop abort");
      // The abort reached the child: the loop stopped at N, it did NOT consume
      // the 40 rounds the model was willing to supply.
      expect(calls).toBe(8);
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(8);
    });
  }, 20_000);

  it("does NOT terminate a turn whose tool calls succeed", async () => {
    await withThreshold("3", async () => {
      let calls = 0;
      const runner = prepare({
        rounds: 6,
        toolExecute: async ({ file_path }) => {
          calls += 1;
          return `[${file_path}: lines 1-2 of 2]\n1 | ok`;
        },
      });
      const result = await runner.run(REQUEST);
      expect(result.output).not.toContain("tool-failure-loop abort");
      expect(calls).toBeGreaterThan(3);
    });
  }, 20_000);
});
