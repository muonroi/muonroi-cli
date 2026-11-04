import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { readContextPreservation } from "./context-preservation.js";

describe("context preservation scope", () => {
  it("does not let an older assistant veto compaction in a new user turn", () => {
    expect(
      readContextPreservation([
        { role: "assistant", content: "PRESERVE_FULL_CONTEXT" },
        { role: "user", content: "Continue verification" },
      ]).preserveFullContext,
    ).toBe(false);
  });

  it("ignores user/tool text and explanatory mentions of the marker", () => {
    const messages = [
      { role: "user", content: "Explain PRESERVE_FULL_CONTEXT" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "doc",
            toolName: "read_file",
            output: { type: "text", value: "PRESERVE_FULL_CONTEXT" },
          },
        ],
      },
      { role: "assistant", content: "The PRESERVE_FULL_CONTEXT marker controls compaction." },
    ] as ModelMessage[];
    expect(readContextPreservation(messages).preserveFullContext).toBe(false);
  });

  it("honors active assistant directives including reasoning and hyphenated tool IDs", () => {
    const messages = [
      { role: "user", content: "Inspect evidence" },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "PRESERVE_FULL_CONTEXT\nKEEP_TOOL_IDS: call-1, call_2" }],
      },
    ] as ModelMessage[];
    expect(readContextPreservation(messages)).toEqual({ preserveFullContext: true, keepToolIds: ["call-1", "call_2"] });
  });
});
