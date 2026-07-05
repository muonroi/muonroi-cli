/**
 * Verifies the wire-debug message summarizer redacts content but preserves
 * structural shape needed to diagnose provider-specific failures
 * (e.g. DeepSeek reasoning_content round-trip).
 */
import { describe, expect, it } from "vitest";
import { _internals } from "../wire-debug.js";

const { summarizeMessage } = _internals;

describe("wire-debug summarizeMessage", () => {
  it("captures role + string content length", () => {
    expect(summarizeMessage({ role: "user", content: "hello world" })).toEqual({
      role: "user",
      contentKind: "string",
      textChars: 11,
    });
  });

  it("captures parts-array role + part types + tool call ids", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "text", text: "thinking..." },
        { type: "tool-call", toolCallId: "call_1", toolName: "read_file" },
        { type: "reasoning", text: "internal monologue" },
      ],
    };
    const shape = summarizeMessage(m);
    expect(shape.role).toBe("assistant");
    expect(shape.contentKind).toBe("parts");
    expect(shape.partTypes).toEqual(["text", "tool-call", "reasoning"]);
    expect(shape.toolCallIds).toEqual(["call_1"]);
    expect(shape.textChars).toBe("thinking...".length + "internal monologue".length);
  });

  it("handles missing/unknown role gracefully", () => {
    const shape = summarizeMessage({ content: "" });
    expect(shape.role).toBe("?");
    expect(shape.textChars).toBe(0);
  });
});
