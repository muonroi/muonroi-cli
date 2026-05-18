/**
 * tests/harness/cost-leak-b3.spec.ts
 *
 * Cost-leak verification: B3 — sub-agent `prepareStep` compactor keeps the
 * cumulative input chars across a multi-round tool loop from ballooning.
 *
 * The orchestrator wires `compactSubAgentMessages` into the sub-agent
 * `streamText` call at src/orchestrator/orchestrator.ts (see Phase B3
 * wiring). This spec drives the same shape locally so the compactor's
 * effect on the recorded LanguageModelV3CallOptions is observable without
 * spinning up the full orchestrator.
 *
 * Failing mode (pre-fix): each round re-sends every prior tool_result in
 * full. With 4 rounds × ~30k chars per tool result + accumulating history,
 * cumulativePromptChars(handle) for the sub-agent calls climbs past 360k.
 *
 * Passing mode (post-fix): older tool_result parts are rewritten to short
 * stubs before each step → cumulativePromptChars stays well under 250k.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { installMockModel } from "../../src/agent-harness/mock-model.js";
import { compactSubAgentMessages } from "../../src/orchestrator/subagent-compactor.js";
import { cumulativePromptChars, inspectByRole } from "./recording.js";

// Helper: emit a `tool-call` step that the AI SDK will round-trip into an
// actual tool execution. The tool result is appended to the messages array
// the SDK passes to the NEXT doStream call.
function toolCallChunks(id: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "fake_read",
      input: JSON.stringify({ path: `/tmp/${id}.txt` }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

// Final round: the model emits free text and stops.
function finalTextChunks(text: string): LanguageModelV3StreamPart[] {
  const id = "final";
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    {
      type: "finish",
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

/**
 * Stub tool whose `execute` returns ~30,000 chars. AI SDK appends the result
 * to messages on the next round — that's how the prompt size grows.
 */
function buildFakeReadTool() {
  return {
    fake_read: tool({
      description: "Stub read for cost-leak-b3 verification.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }: { path: string }) => {
        return `READ:${path}\n` + "x".repeat(40_000);
      },
    }),
  };
}

async function runSubAgent(opts: { withCompactor: boolean }): Promise<{
  handle: ReturnType<typeof installMockModel>;
  uninstall: () => void;
}> {
  const handle = installMockModel({
    fixture: {
      stream: [toolCallChunks("c1"), toolCallChunks("c2"), toolCallChunks("c3"), finalTextChunks("done")],
    },
  });

  const result = streamText({
    model: handle.model,
    system: "You are the Explore sub-agent. You are read-only.",
    messages: [{ role: "user", content: "trace auth wiring" }],
    tools: buildFakeReadTool(),
    stopWhen: stepCountIs(8),
    maxRetries: 0,
    ...(opts.withCompactor
      ? {
          prepareStep: ({ messages, stepNumber }) => {
            if (stepNumber < 1) return undefined;
            const compacted = compactSubAgentMessages(messages, {
              thresholdChars: 60_000,
              keepLastTurns: 1,
            });
            if (compacted === messages) return undefined;
            return { messages: compacted };
          },
        }
      : {}),
  });

  // Drain the full stream so every round-trip's doStream call is recorded.
  for await (const _ of result.fullStream) {
    // discard
  }

  return { handle, uninstall: handle.uninstall };
}

describe("B3: sub-agent prepareStep compactor caps cumulative prompt size", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("control: WITHOUT compactor → cumulative prompt grows unbounded across rounds", async () => {
    const { handle, uninstall } = await runSubAgent({ withCompactor: false });
    cleanup = uninstall;

    const subAgentCalls = inspectByRole(handle, "sub-agent");
    expect(subAgentCalls.length).toBeGreaterThanOrEqual(4);

    // Last call must have seen all prior tool results in full.
    const lastCall = subAgentCalls[subAgentCalls.length - 1]!;
    expect(lastCall.promptChars).toBeGreaterThan(80_000);

    // Cumulative across 4 doStream calls grows as O(N^2) with rounds.
    // 40k tool results × 4 rounds → ~240k cumulative (call0: 0, call1: 40k,
    // call2: 80k, call3: 120k). Real-world repro with deeper loops hits 500k+.
    const total = cumulativePromptChars(handle);
    expect(total).toBeGreaterThan(200_000);
  });

  it("WITH compactor → cumulative prompt stays under ~250k across 4 rounds", async () => {
    const { handle, uninstall } = await runSubAgent({ withCompactor: true });
    cleanup = uninstall;

    const subAgentCalls = inspectByRole(handle, "sub-agent");
    expect(subAgentCalls.length).toBeGreaterThanOrEqual(4);

    const total = cumulativePromptChars(handle);
    expect(total).toBeLessThan(250_000);

    // Last call must reflect the compacted shape: at least one tool message
    // has been rewritten into the elision stub.
    const lastCall = subAgentCalls[subAgentCalls.length - 1]!;
    const promptText = JSON.stringify(lastCall.options.prompt);
    expect(promptText).toMatch(/elided by sub-agent compactor/);
  });

  it("with-compactor cumulative is materially lower than without-compactor", async () => {
    const { handle: h1, uninstall: u1 } = await runSubAgent({ withCompactor: false });
    const without = cumulativePromptChars(h1);
    u1();

    const { handle: h2, uninstall: u2 } = await runSubAgent({ withCompactor: true });
    const withCompactor = cumulativePromptChars(h2);
    u2();

    // Measured at 49.5% reduction (240,714 → 121,566 across 4 rounds × 40k
    // tool result). Larger reductions expected in long-running real sessions.
    // At least 30% reduction is the minimum acceptance threshold; real-world
    // savings are higher because the elision stub is ~200 chars vs ~30k raw.
    expect(withCompactor).toBeLessThan(without * 0.7);
  });
});
