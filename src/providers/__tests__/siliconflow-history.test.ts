/**
 * Verifies SiliconFlow-specific reasoning-strip transform. Backed by evidence
 * from wire.log: SiliconFlow rejects assistant history with reasoning parts
 * (HTTP 400 code 20015) because @ai-sdk/openai-compatible does not serialize
 * them as reasoning_content. The strip is gated by providerId at the call
 * site; this module is reusable but pure.
 */
import { describe, expect, it } from "vitest";
import { _internals, stripReasoningForSiliconflow } from "../siliconflow-history.js";

describe("stripReasoningForSiliconflow", () => {
  it("returns input by reference when no message has reasoning parts", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const out = stripReasoningForSiliconflow(messages);
    expect(out).toBe(messages);
  });

  it("strips reasoning parts from assistant content array", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal monologue" },
          { type: "text", text: "Hello!" },
        ],
      },
    ];
    const out = stripReasoningForSiliconflow(messages);
    expect(out).not.toBe(messages);
    expect(out).toHaveLength(2);
    expect(out[1]!.content).toEqual([{ type: "text", text: "Hello!" }]);
    // Original untouched
    expect((messages[1]!.content as unknown[]).length).toBe(2);
  });

  it("leaves user/system messages alone even if they contain reasoning-shaped parts", () => {
    const messages = [
      { role: "system", content: "be helpful" },
      { role: "user", content: [{ type: "reasoning", text: "not really reasoning" }] },
    ];
    const out = stripReasoningForSiliconflow(messages);
    expect(out).toBe(messages);
  });

  it("preserves tool-call parts on assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "think" },
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} },
        ],
      },
    ];
    const out = stripReasoningForSiliconflow(messages);
    expect(out[0]!.content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} }]);
  });

  it("keeps assistant message even if stripping leaves content=[] (preserves tool pairing)", () => {
    const messages = [
      { role: "assistant", content: [{ type: "reasoning", text: "only thinking" }] },
      { role: "user", content: "what?" },
    ];
    const out = stripReasoningForSiliconflow(messages);
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toEqual([]);
    expect(out[0]!.role).toBe("assistant");
  });

  it("hasReasoningPart returns false for string content", () => {
    expect(_internals.hasReasoningPart({ role: "assistant", content: "plain text" })).toBe(false);
  });

  it("hasReasoningPart returns true only for assistant role with reasoning part", () => {
    expect(_internals.hasReasoningPart({ role: "user", content: [{ type: "reasoning" }] })).toBe(false);
    expect(_internals.hasReasoningPart({ role: "assistant", content: [{ type: "reasoning" }] })).toBe(true);
  });
});
