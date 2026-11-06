/**
 * StreamRunner worker-recovery paths, driven over the REAL AI-SDK multi-step
 * loop with a mock model (same harness shape as stream-runner-failure-loop.test).
 * Each case reproduces one failure class measured in the TCIS.MCP.Docs run
 * (sessions 8a5bd89c2be0 / 4edc02516a92) — see worker-stream-recovery.ts.
 */

import { APICallError, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMockModel, type StreamChunks } from "../agent-harness/mock-model.js";
import { analyzePrompt, wrapModelWithGate } from "../providers/model-gate.js";
import type { TaskRequest } from "../types/index.js";
import { type PreparedSubAgentCall, StreamRunner, type StreamRunnerDeps } from "./stream-runner.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { LENGTH_CONTINUATION_PROMPT, REASONING_OVERFLOW_PROMPT } from "./worker-stream-recovery.js";

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function toolRound(id: string, toolName: string, input: Record<string, unknown>): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function textRound(text: string, finish: "stop" | "length" = "stop"): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: finish, raw: undefined }, usage: USAGE },
  ];
}

function reasoningToolRound(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  reasoningChars: number,
): StreamChunks {
  const rid = `r-${id}`;
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: rid },
    { type: "reasoning-delta", id: rid, delta: `think-${id} ${"r".repeat(reasoningChars)}` },
    { type: "reasoning-end", id: rid },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function reasoningOnlyLengthRound(): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "thinking ".repeat(50) },
    { type: "reasoning-end", id: "r" },
    { type: "finish", finishReason: { unified: "length", raw: undefined }, usage: USAGE },
  ];
}

function rejectRound(statusCode: number): StreamChunks {
  return [
    {
      type: "error",
      rejectRequest: true,
      error: new APICallError({
        message: "The engine is currently overloaded, please try again later",
        url: "https://provider.invalid/v1/chat/completions",
        requestBodyValues: {},
        statusCode,
      }),
    } as unknown as LanguageModelV3StreamPart,
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

const REQUEST: TaskRequest = { agent: "general", description: "worker", prompt: "go" };

// biome-ignore lint/suspicious/noExplicitAny: provider-shaped mock model handle
function prepare(model: any, tools: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const childBash = { getCwd: () => process.cwd() } satisfies Pick<PreparedSubAgentCall["childBash"], "getCwd">;
  const prepared = {
    request: REQUEST,
    agentKey: "general",
    childMode: "yolo",
    childBash,
    childRuntime: {
      model,
      modelId: "mock-model",
      modelInfo: { id: "mock-model", provider: "deepseek", contextWindow: 128_000 },
    },
    childSystem: "you are a sub-agent",
    childMessages: [{ role: "user", content: "go" }],
    childTools: tools,
    initialDetail: "starting",
    lastActivity: "starting",
    maxSteps: 40,
    useBatchApi: false,
    ...extra,
  } as unknown as PreparedSubAgentCall;
  const runner = new StreamRunner(makeDeps());
  (runner as unknown as { setup: () => Promise<unknown> }).setup = async () => ({ kind: "prepared", prepared });
  return runner;
}

const readTool = tool({
  description: "read a file",
  inputSchema: z.object({ file_path: z.string() }),
  execute: async ({ file_path }: { file_path: string }) => `contents of ${file_path}`,
});

function promptText(call: unknown): string {
  return JSON.stringify((call as { prompt?: unknown }).prompt ?? null);
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamRunner worker recovery", () => {
  it("retries a transient HTTP 503 on step 2 instead of failing the worker (lively-amber-owl)", async () => {
    const handle = createMockModel({
      stream: [toolRound("c1", "read_file", { file_path: "a.ts" }), rejectRound(503), textRound("final report")],
    });
    const result = await prepare(handle.model, { read_file: readTool }).run(REQUEST);
    expect(result.success).toBe(true);
    expect(result.output).toBe("final report");
    // Three doStream calls: step 1, the rejected step 2, the retried step 2 with
    // the identical prompt (no tool replay).
    expect(handle.calls).toHaveLength(3);
    expect(promptText(handle.calls[2])).toBe(promptText(handle.calls[1]));
  }, 20_000);

  it("continues an answer the output limit cut off and returns the joined text (keen-blue-lynx)", async () => {
    const handle = createMockModel({
      stream: [
        toolRound("c1", "read_file", { file_path: "a.ts" }),
        textRound("first half, ", "length"),
        textRound("second half."),
      ],
    });
    const result = await prepare(handle.model, { read_file: readTool }).run(REQUEST);
    expect(result.success).toBe(true);
    expect(result.output).toBe("first half, second half.");
    const continuation = handle.calls[2];
    expect(promptText(continuation)).toContain(LENGTH_CONTINUATION_PROMPT.slice(0, 60));
    // The continuation turn is tool-free.
    expect((continuation as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
  });

  it("keeps the incomplete label when continuations are exhausted", async () => {
    const handle = createMockModel({
      stream: [textRound("a", "length"), textRound("b", "length"), textRound("c", "length")],
    });
    const result = await prepare(handle.model, {}).run(REQUEST);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^worker_incomplete: final answer reached the output limit/);
    expect(result.output).toContain("abc");
  });

  it("re-asks for the report after a reasoning-only output-limit step (calm-copper-otter shape)", async () => {
    const handle = createMockModel({
      stream: [
        toolRound("c1", "read_file", { file_path: "a.ts" }),
        reasoningOnlyLengthRound(),
        textRound("the report"),
      ],
    });
    const result = await prepare(handle.model, { read_file: readTool }).run(REQUEST);
    expect(result.success).toBe(true);
    expect(result.output).toBe("the report");
    expect(promptText(handle.calls[2])).toContain(REASONING_OVERFLOW_PROMPT.slice(0, 60));
  });

  it("does not let tool execution time trip the provider-stall watchdog (brisk-white-heron)", async () => {
    await withEnv({ MUONROI_PROVIDER_STALL_TIMEOUT_MS: "10000" }, async () => {
      const slowTool = tool({
        description: "run a command",
        inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
        execute: async () => {
          await new Promise((r) => setTimeout(r, 11_000));
          return "tests passed";
        },
      });
      const handle = createMockModel({
        stream: [toolRound("c1", "bash", { command: "dotnet test", timeout: 600_000 }), textRound("all green")],
      });
      const result = await prepare(handle.model, { bash: slowTool }).run(REQUEST);
      expect(result.success).toBe(true);
      expect(result.output).toBe("all green");
    });
  }, 30_000);

  it("labels a provider stall after real work as incomplete and returns the worker's report (lively-ivory-panda)", async () => {
    await withEnv({ MUONROI_PROVIDER_STALL_TIMEOUT_MS: "10000" }, async () => {
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          call += 1;
          if (call === 2) {
            // Accepts the request, never sends a chunk; like a real fetch body it
            // errors once the request is aborted.
            return {
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  options.abortSignal?.addEventListener("abort", () =>
                    controller.error(options.abortSignal?.reason ?? new DOMException("aborted", "AbortError")),
                  );
                },
              }),
            };
          }
          const chunks =
            call === 1 ? toolRound("c1", "read_file", { file_path: "a.ts" }) : textRound("edited a.ts; tests not run");
          return {
            stream: simulateReadableStream<LanguageModelV3StreamPart>({
              chunks: chunks as LanguageModelV3StreamPart[],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      });
      const result = await prepare(model, { read_file: readTool }).run(REQUEST);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^worker_incomplete: provider stalled after 1 tool calls/);
      expect(result.output).toContain("edited a.ts; tests not run");
      expect(call).toBe(3);
    });
  }, 30_000);

  it("compacts a long worker under the gate's input line instead of failing at it (gentle-violet-panda)", async () => {
    // Throw line lowered so the run stays small; the gate itself is the real one.
    await withEnv({ MUONROI_GATE_THROW_MAX_TOKENS: "20000", MUONROI_GATE_CEILING: "throw" }, async () => {
      const STEPS = 12;
      // Test-fixing worker: every grep mentions a failure, so the B3 cost pass
      // keeps each 9k result verbatim (isHighValueToolResult) at any age.
      const grepTool = tool({
        description: "search",
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }: { pattern: string }) =>
          `ParserTests.cs: Assert failed for ${pattern}\n${"x".repeat(9_000)}`,
      });
      const rounds: StreamChunks[] = [];
      for (let i = 0; i < STEPS; i++) rounds.push(reasoningToolRound(`c${i}`, "grep", { pattern: `p${i}` }, 6_000));
      rounds.push(textRound("final report"));
      const handle = createMockModel({ stream: rounds });
      const gated = wrapModelWithGate(handle.model, { stage: "subagent", modelId: "mock-model" });
      const result = await prepare(
        gated,
        { grep: grepTool },
        {
          childRuntime: {
            model: gated,
            modelId: "mock-model",
            modelInfo: { id: "mock-model", provider: "deepseek", contextWindow: 1_000_000, reasoning: true },
          },
          subAgentCapState: wrapToolSetWithCap({}).state,
        },
      ).run(REQUEST);

      expect(result.success).toBe(true);
      expect(result.output).toBe("final report");
      // Every request reached the provider: none was refused by the gate ...
      expect(handle.calls).toHaveLength(STEPS + 1);
      const ests = handle.calls.map((c) => analyzePrompt((c as { prompt?: unknown }).prompt).estInputTokens);
      // ... and every one stayed under the line, while the raw transcript did not.
      for (const est of ests) expect(est).toBeLessThanOrEqual(20_000);
      const rawChars = STEPS * (9_000 + 6_000);
      expect(rawChars / 4).toBeGreaterThan(20_000);
      const last = promptText(handle.calls[STEPS]);
      expect(last).toContain("elided by sub-agent compactor");
      expect(last).toContain("think-c11 ");
      expect(last).not.toContain("think-c10 ");
    });
  }, 30_000);
});
