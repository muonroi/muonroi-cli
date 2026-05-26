/**
 * Real-fix proof for the "reasoning_content must be passed back" rejection
 * that previously hit DeepSeek/SiliconFlow (HTTP 400 code 20015).
 *
 * The previous workaround (commit 42d5440, May 2026) disabled thinking mode
 * entirely because @ai-sdk/openai-compatible reportedly did not serialize
 * assistant reasoning parts as `reasoning_content`. This test asserts the
 * opposite for the version pinned in package.json (2.0.42) by capturing the
 * actual outgoing request body through a stub `fetch` and inspecting the
 * serialized payload.
 *
 * If this test passes, the workaround is unnecessary and reasoning_content
 * round-trips natively — which is what removed the `thinking-disabled`
 * unconditional gate. If it ever fails (upstream regression), put the gate
 * back in DeepSeekProviderCapabilities.buildProviderOptions.
 *
 * Reference: dist/index.js:257-263 in
 *   node_modules/.bun/@ai-sdk+openai-compatible@2.0.42/.../dist/index.js
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function makeStubProvider(name: string, capture: { current: CapturedRequest | null }) {
  return createOpenAICompatible({
    name,
    baseURL: "https://example.test/v1",
    apiKey: "stub-key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      capture.current = {
        url,
        body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
      };
      const sse = [
        'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

describe("reasoning_content round-trip — AI SDK 2.0.42 wire shape", () => {
  it("siliconflow: serializes assistant reasoning part as reasoning_content in request body", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("siliconflow", capture);
    const model = provider("deepseek-ai/DeepSeek-V4-Flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "The user is asking basic arithmetic; the answer is four." },
            { type: "text", text: "4" },
          ],
        },
        { role: "user", content: "Now what is 2+3?" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg, "assistant message must be present in wire body").toBeDefined();
    expect(assistantMsg!.reasoning_content).toBe("The user is asking basic arithmetic; the answer is four.");
    expect(assistantMsg!.content).toBe("4");
  });

  it("deepseek: serializes assistant reasoning part as reasoning_content in request body", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("deepseek", capture);
    const model = provider("deepseek-v4-flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "Read foo.txt" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I need to call the read_file tool." },
            { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "foo.txt" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "read_file",
              output: { type: "text", value: "contents" },
            },
          ],
        },
        { role: "user", content: "summarize" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg, "assistant message with tool-call must round-trip").toBeDefined();
    expect(assistantMsg!.reasoning_content).toBe("I need to call the read_file tool.");
    expect(Array.isArray(assistantMsg!.tool_calls)).toBe(true);
    expect((assistantMsg!.tool_calls as Array<Record<string, unknown>>)[0]?.id).toBe("c1");
  });

  it("emits no reasoning_content key when there are no reasoning parts (no false positives)", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("siliconflow", capture);
    const model = provider("deepseek-ai/DeepSeek-V4-Flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        { role: "user", content: "Again" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.reasoning_content).toBeUndefined();
  });
});
