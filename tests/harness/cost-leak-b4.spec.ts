/**
 * tests/harness/cost-leak-b4.spec.ts
 *
 * Cost-leak verification: B4 — top-level orchestrator `prepareStep`
 * compactor (sibling of B3 for the sub-agent path).
 *
 * The orchestrator wires `compactSubAgentMessages({label: "top-level"})`
 * into the top-level streamText call (orchestrator.ts ~line 4000). This
 * spec mirrors that pattern with a MockLanguageModelV3 so the recorded
 * LanguageModelV3CallOptions reflect the post-compaction shape.
 *
 * Differences from B3:
 *   - Top-level uses a higher default threshold (200k vs 80k chars) and
 *     more kept-last turns (5 vs 3). This spec uses lower numbers to make
 *     the deterministic test fast.
 *   - Stub text reads "elided by top-level compactor" (label-driven).
 *
 * Failing mode (pre-B4): top-level streamText omits prepareStep → every
 * round re-sends full tool_result history → cumulative input balloons
 * exactly like B3 did for sub-agents (session 7d36a8d 324k example).
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { installMockModel } from "../../src/agent-harness/mock-model.js";
import { compactSubAgentMessages } from "../../src/orchestrator/subagent-compactor.js";
import { cumulativePromptChars, inspectByRole } from "./recording.js";

function toolCallChunks(id: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "fake_grep",
      input: JSON.stringify({ pattern: id }),
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

function buildFakeGrepTool() {
  return {
    fake_grep: tool({
      description: "Stub grep for cost-leak-b4 verification.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }: { pattern: string }) => {
        return `GREP:${pattern}\n${"x".repeat(40_000)}`;
      },
    }),
  };
}

async function runTopLevel(opts: { withCompactor: boolean }): Promise<{
  handle: ReturnType<typeof installMockModel>;
  uninstall: () => void;
}> {
  const handle = installMockModel({
    fixture: {
      stream: [
        toolCallChunks("c1"),
        toolCallChunks("c2"),
        toolCallChunks("c3"),
        toolCallChunks("c4"),
        finalTextChunks("done"),
      ],
    },
  });

  const result = streamText({
    model: handle.model,
    // Top-level system prompt — anything that does NOT start with "You are
    // the X sub-agent." so inspectByRole categorizes it as "top-level".
    system: "You are the muonroi-cli top-level assistant. Use tools to investigate.",
    messages: [{ role: "user", content: "trace the auth flow" }],
    tools: buildFakeGrepTool(),
    stopWhen: stepCountIs(10),
    maxRetries: 0,
    ...(opts.withCompactor
      ? {
          prepareStep: ({ messages, stepNumber }) => {
            if (stepNumber < 1) return undefined;
            const compacted = compactSubAgentMessages(messages, {
              thresholdChars: 60_000,
              keepLastTurns: 1,
              label: "top-level",
            });
            if (compacted === messages) return undefined;
            return { messages: compacted };
          },
        }
      : {}),
  });

  for await (const _ of result.fullStream) {
    // discard
  }

  return { handle, uninstall: handle.uninstall };
}

describe("B4: top-level prepareStep compactor caps cumulative prompt size", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("control: WITHOUT compactor → cumulative grows unbounded (5 rounds × 40k)", async () => {
    const { handle, uninstall } = await runTopLevel({ withCompactor: false });
    cleanup = uninstall;

    const calls = inspectByRole(handle, "top-level");
    expect(calls.length).toBeGreaterThanOrEqual(5);

    const total = cumulativePromptChars(handle);
    // 5 calls × accumulating 40k tool results → 0 + 40k + 80k + 120k + 160k = ~400k
    expect(total).toBeGreaterThan(300_000);
  });

  it("WITH compactor → cumulative stays well under control's worst case", async () => {
    const { handle, uninstall } = await runTopLevel({ withCompactor: true });
    cleanup = uninstall;

    const calls = inspectByRole(handle, "top-level");
    expect(calls.length).toBeGreaterThanOrEqual(5);

    const total = cumulativePromptChars(handle);
    expect(total).toBeLessThan(350_000);

    // Last call must have at least one "top-level" elision stub in its
    // prompt — proves label option is honored end-to-end.
    const lastCall = calls[calls.length - 1]!;
    const promptText = JSON.stringify(lastCall.options.prompt);
    expect(promptText).toMatch(/elided by top-level compactor/);
  });

  it("with-compactor cumulative is materially lower than without-compactor", async () => {
    const { handle: h1, uninstall: u1 } = await runTopLevel({ withCompactor: false });
    const without = cumulativePromptChars(h1);
    u1();

    const { handle: h2, uninstall: u2 } = await runTopLevel({ withCompactor: true });
    const withCompactor = cumulativePromptChars(h2);
    u2();

    // Same 30% reduction floor as B3 acceptance.
    expect(withCompactor).toBeLessThan(without * 0.7);
  });

  it("label option is distinct from sub-agent default", async () => {
    const { handle, uninstall } = await runTopLevel({ withCompactor: true });
    cleanup = uninstall;

    const promptText = JSON.stringify(inspectByRole(handle, "top-level"));
    expect(promptText).toMatch(/elided by top-level compactor/);
    expect(promptText).not.toMatch(/elided by sub-agent compactor/);
  });
});
