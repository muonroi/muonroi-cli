import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { scrubImagePayloadsInMessages } from "../../../../src/providers/mcp-vision-bridge.ts";

const signature = "A".repeat(4096);
const original = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { signature } } },
      { type: "text", text: "Previous answer" },
    ],
  },
];
const scrubbed = scrubImagePayloadsInMessages(original);
let wireSignature;
const provider = createAnthropic({
  apiKey: "x".repeat(32),
  fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    wireSignature = body.messages[0].content[0].signature;
    return Response.json({
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
});
await generateText({
  model: provider("claude-sonnet-5-5"),
  messages: [...scrubbed, { role: "user", content: "Continue" }],
  providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
});
console.log(
  JSON.stringify({
    originalLength: signature.length,
    persistedLength: scrubbed[0].content[0].providerOptions.anthropic.signature.length,
    wirePreserved: wireSignature === signature,
    wirePlaceholder: wireSignature?.startsWith("[image data removed"),
  }),
);
