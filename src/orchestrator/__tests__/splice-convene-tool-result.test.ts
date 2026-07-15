import { describe, expect, it } from "vitest";
import { spliceConveneToolResult } from "../tool-engine.js";

type Msg = { role: string; content?: any };

const history = (): Msg[] => [
  { role: "user", content: "do X" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "convene_council" }] },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "convene_council",
        output: "Council convening — placeholder",
      },
    ],
  },
];

describe("spliceConveneToolResult", () => {
  it("replaces the tool-result value by toolCallId and preserves pairing", () => {
    const { messages, replaced } = spliceConveneToolResult(history(), "tc-1", "SYNTHESIS TEXT");
    expect(replaced).toBe(true);
    const toolMsg = messages.find((m) => m.role === "tool")!;
    const part = (toolMsg.content as any[])[0];
    expect(part.output).toBe("SYNTHESIS TEXT");
    expect(part.result).toBe("SYNTHESIS TEXT");
    expect(part.isError).toBe(false);
    // toolCallId preserved → the assistant tool-call still pairs with it.
    expect(part.toolCallId).toBe("tc-1");
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect((assistant.content as any[])[0].toolCallId).toBe("tc-1");
  });

  it("returns the original array + replaced=false when toolCallId is absent", () => {
    const h = history();
    const { messages, replaced } = spliceConveneToolResult(h, "tc-missing", "X");
    expect(replaced).toBe(false);
    expect(messages).toBe(h); // same reference, untouched
  });

  it("returns replaced=false for a null toolCallId", () => {
    const h = history();
    const { messages, replaced } = spliceConveneToolResult(h, null, "X");
    expect(replaced).toBe(false);
    expect(messages).toBe(h);
  });

  it("only touches the matching part, leaving other tool-results intact", () => {
    const h: Msg[] = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "other", output: "keep" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "tc-1", output: "placeholder" }] },
    ];
    const { messages } = spliceConveneToolResult(h, "tc-1", "NEW");
    expect((messages[0].content as any[])[0].output).toBe("keep");
    expect((messages[1].content as any[])[0].output).toBe("NEW");
  });
});
