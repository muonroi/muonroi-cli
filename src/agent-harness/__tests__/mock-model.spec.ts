/**
 * Unit tests for the mock-model helper. Verifies the recording surface and
 * sequential stream semantics that downstream cost-leak specs depend on.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMockModel, textOnlyStream, toolCallStream } from "../mock-model.js";

// biome-ignore lint/suspicious/noExplicitAny: streamText result generic is provider-specific
async function drainStream(result: { fullStream: AsyncIterable<any> }): Promise<void> {
  for await (const _ of result.fullStream) {
    // discard — we only care about the model's recorded calls
  }
}

describe("createMockModel", () => {
  it("records every doStream call with full options", async () => {
    const handle = createMockModel({ stream: textOnlyStream("hello") });

    const result = streamText({
      model: handle.model,
      prompt: "say hi",
      maxOutputTokens: 50,
      temperature: 0.7,
    });
    await drainStream(result);

    expect(handle.calls.length).toBe(1);
    expect(handle.calls[0]?.maxOutputTokens).toBe(50);
    expect(handle.calls[0]?.temperature).toBe(0.7);
  });

  it("preserves providerOptions in recorded calls", async () => {
    const handle = createMockModel({ stream: textOnlyStream("hello") });

    const result = streamText({
      model: handle.model,
      prompt: "say hi",
      providerOptions: { openai: { promptCacheKey: "abc123" } },
    });
    await drainStream(result);

    expect(handle.calls[0]?.providerOptions).toEqual({
      openai: { promptCacheKey: "abc123" },
    });
  });

  it("advances the stream sequence across multiple rounds", async () => {
    const handle = createMockModel({
      stream: [toolCallStream({ toolCallId: "1", toolName: "echo", input: { msg: "hi" } }), textOnlyStream("done")],
    });

    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async ({ msg }: { msg: string }) => `echoed: ${msg}`,
    });

    const result = streamText({
      model: handle.model,
      prompt: "use echo",
      tools: { echo: echoTool },
      stopWhen: stepCountIs(3),
    });
    await drainStream(result);

    expect(handle.calls.length).toBe(2);
    // Round 1 sees only the user message; round 2 sees the tool result too.
    expect(handle.calls[1]?.prompt.length).toBeGreaterThan(handle.calls[0]?.prompt.length ?? 0);
  });

  it("repeats the last stream entry when sequence is exhausted", async () => {
    const handle = createMockModel({ stream: [textOnlyStream("once")] });
    // Drive two calls — second should silently reuse the last entry.
    for (let i = 0; i < 2; i++) {
      const r = streamText({ model: handle.model, prompt: `q${i}` });
      await drainStream(r);
    }
    expect(handle.calls.length).toBe(2);
  });

  it("reset() clears doStreamCalls and rewinds the sequence index", async () => {
    const handle = createMockModel({
      stream: [textOnlyStream("first"), textOnlyStream("second")],
    });
    const r1 = streamText({ model: handle.model, prompt: "q1" });
    await drainStream(r1);
    expect(handle.calls.length).toBe(1);

    handle.reset();
    expect(handle.calls.length).toBe(0);

    // After reset, the sequence index is back at 0 → next call gets "first" again.
    const r2 = streamText({ model: handle.model, prompt: "q2" });
    await drainStream(r2);
    expect(handle.calls.length).toBe(1);
  });

  it("textOnlyStream emits a well-formed finish chunk", () => {
    const chunks = textOnlyStream("hi");
    const finish = chunks.find((c): c is Extract<LanguageModelV3StreamPart, { type: "finish" }> => c.type === "finish");
    expect(finish?.finishReason.unified).toBe("stop");
    expect(finish?.usage.outputTokens.total).toBeGreaterThan(0);
  });

  it("toolCallStream emits a tool-calls finish reason", () => {
    const chunks = toolCallStream({ toolCallId: "x", toolName: "t", input: {} });
    const finish = chunks.find((c): c is Extract<LanguageModelV3StreamPart, { type: "finish" }> => c.type === "finish");
    expect(finish?.finishReason.unified).toBe("tool-calls");
  });
});
