/**
 * tests/harness/subagent-step-meter.spec.ts
 *
 * Integration proof that per-step cache instrumentation fires once per AI-SDK
 * step and produces a well-formed row. StreamRunner.runStream attaches an
 * `onStepFinish` that calls `buildSubAgentStepData(...)` then `logInteraction`
 * — this spec drives the SAME real `streamText` multi-step loop the sub-agent
 * uses (mirroring cost-leak-b3.spec) and asserts the callback fires per step,
 * so the "0 rows in a live council drive" observation (that was council-implement
 * simply never running, not a wiring bug) is disambiguated with a deterministic
 * check.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { installMockModel } from "../../src/agent-harness/mock-model.js";
import { buildSubAgentStepData } from "../../src/orchestrator/subagent-step-meter.js";

function toolCallChunks(id: string, cacheRead: number): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: "fake_read", input: JSON.stringify({ path: `/tmp/${id}.txt` }) },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1000, noCache: 1000 - cacheRead, cacheRead, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

function finalTextChunks(text: string, cacheRead: number): LanguageModelV3StreamPart[] {
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
        inputTokens: { total: 2000, noCache: 2000 - cacheRead, cacheRead, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

function buildFakeReadTool() {
  return {
    fake_read: tool({
      description: "fake read",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }: { path: string }) => `READ:${path}`,
    }),
  };
}

describe("sub-agent per-step meter fires once per step with parsed cache", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("records one row per step, incrementing stepIndex, with cacheRead parsed", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [toolCallChunks("c1", 100), toolCallChunks("c2", 400), finalTextChunks("done", 900)],
      },
    });
    uninstall = handle.uninstall;

    // Mirror of StreamRunner.runStream's onStepFinish (the glue there is 6 lines
    // over this same helper; here we exercise the real SDK callback firing).
    const rows: Array<ReturnType<typeof buildSubAgentStepData>> = [];
    let stepIndex = 0;

    const result = streamText({
      model: handle.model,
      system: "You are the Explore sub-agent.",
      messages: [{ role: "user", content: "trace auth wiring" }],
      tools: buildFakeReadTool(),
      stopWhen: stepCountIs(8),
      maxRetries: 0,
      onStepFinish: ({ usage }) => {
        rows.push(buildSubAgentStepData(usage, { stepIndex: stepIndex++, callId: "sub-test" }));
      },
    });
    for await (const _ of result.fullStream) {
      // drain
    }

    // 2 tool-call steps + 1 final text step = 3 onStepFinish invocations.
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
    // cache_read flows through per step (normalized by the SDK to cachedInputTokens).
    expect(rows[0]!.cacheReadTokens).toBe(100);
    expect(rows[1]!.cacheReadTokens).toBe(400);
    expect(rows[2]!.cacheReadTokens).toBe(900);
    // hitPct derived per step; the curve is now falsifiable (10% → 40% → 45%).
    expect(rows[0]!.hitPct).toBe(10);
    expect(rows[2]!.hitPct).toBe(45);
    // every row carries the call id for grouping steps of one sub-agent run.
    expect(rows.every((r) => r.callId === "sub-test")).toBe(true);
  });
});
