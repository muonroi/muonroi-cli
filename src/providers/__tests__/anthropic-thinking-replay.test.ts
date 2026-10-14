import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";
import { scrubImagePayloadsInMessages } from "../mcp-vision-bridge.js";

const SIGNATURE = "A".repeat(4096);
const REDACTED_DATA = "B".repeat(4096);
const MOCK_KEY = "x".repeat(32);

async function send(messages: readonly ModelMessage[]) {
  let body: Record<string, any> | undefined;
  const provider = createAnthropic({
    apiKey: MOCK_KEY,
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return Response.json({
        id: "msg_replay",
        type: "message",
        role: "assistant",
        model: body!.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  await generateText({
    model: provider("claude-sonnet-5-5"),
    messages: [...messages],
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
  });
  return body!;
}

describe("Anthropic thinking replay (session d78d41cab2b8)", () => {
  it("preserves omitted thinking signatures and redacted data through image scrubbing and SDK serialization", async () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerOptions: { anthropic: { signature: SIGNATURE } } },
          { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: REDACTED_DATA } } },
          { type: "text", text: "Previous answer" },
        ],
      },
      { role: "user", content: "Continue" },
    ];
    const scrubbed = scrubImagePayloadsInMessages(messages);
    const caps = getProviderCapabilities("anthropic");
    expect(caps.sanitizeHistory(scrubbed)).toBe(scrubbed);
    const body = await send(scrubbed);
    expect(body.messages[0].content).toEqual([
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "redacted_thinking", data: REDACTED_DATA },
      { type: "text", text: "Previous answer" },
    ]);
    expect(messages[0]).toEqual(scrubbed[0]);
  });

  it("protects opaque provider options and metadata even in a tool message", () => {
    const messages = [
      {
        role: "tool",
        content: [],
        providerOptions: { fixture: { signature: SIGNATURE } },
        providerMetadata: { fixture: { encryptedContent: REDACTED_DATA } },
      },
    ];
    expect(scrubImagePayloadsInMessages(messages)).toEqual(messages);
  });

  it("repairs stored image-placeholder signatures without dropping text or tool pairing", async () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { anthropic: { signature: "[image data removed on resume]" } },
          },
          { type: "text", text: "Previous answer" },
        ],
      },
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerOptions: { anthropic: { signature: SIGNATURE } } },
          { type: "tool-call", toolCallId: "read1", toolName: "read_file", input: { path: "file.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ];
    const repaired = getProviderCapabilities("anthropic").sanitizeHistory(messages);
    const body = await send(repaired);
    expect(body.messages.flatMap((m: any) => m.content).some((p: any) => p.type === "thinking")).toBe(false);
    expect(body.messages[0].content[0].text).toBe("Previous answer");
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_use", id: "read1" });
    expect(body.messages[3].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "read1" });
    expect(messages[0].content).toHaveLength(2);
  });

  it("repairs corrupt redacted data and omits a now-empty assistant message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              anthropic: { redactedData: "[image data removed - see vision description below]" },
            },
          },
        ],
      },
      { role: "user", content: "Continue" },
    ];
    expect(getProviderCapabilities("anthropic").sanitizeHistory(messages)).toEqual([messages[1]]);
  });
});
