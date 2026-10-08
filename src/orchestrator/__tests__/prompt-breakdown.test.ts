import { dynamicTool, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { createPromptMeasurer } from "../prompt-breakdown.js";

describe("prepared prompt character breakdown", () => {
  it("counts a large SDK v6 tool result instead of reporting zero", async () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read_file",
            output: { type: "text", value: "x".repeat(80_000) },
          },
        ],
      },
    ];
    const measure = await createPromptMeasurer("SYSTEM", {});
    expect(measure(messages).messagesChars).toBeGreaterThanOrEqual(80_000);
  });

  it("counts reasoning, tool arguments and structured JSON output", async () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "check evidence" },
          { type: "tool-call", toolCallId: "check", toolName: "check", input: { path: "src/main.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "check",
            toolName: "check",
            output: { type: "json", value: { passed: true, evidence: "test passed" } },
          },
        ],
      },
    ];
    const measure = await createPromptMeasurer("", {});
    const measured = measure(messages);
    expect(measured.messagesChars).toBeGreaterThan(
      "check evidence".length + "src/main.ts".length + "test passed".length,
    );
    expect(measured.messagesCount).toBe(2);
  });

  it("measures actual system blocks and resolved tool schemas, including asynchronous schemas", async () => {
    const schema = { type: "object" as const, properties: { evidence: { type: "string" as const } } };
    const tools: ToolSet = {
      check: dynamicTool({
        description: "Check evidence",
        inputSchema: jsonSchema(Promise.resolve(schema)),
        execute: async () => "ok",
      }),
    };
    const measure = await createPromptMeasurer(
      [
        { role: "system", content: "STATIC" },
        { role: "system", content: "DYNAMIC" },
      ],
      tools,
    );
    const measured = measure([]);
    expect(measured.systemChars).toBe(13);
    expect(measured.toolsChars).toBe("check".length + "Check evidence".length + JSON.stringify(schema).length);
    expect(measured.toolsCount).toBe(1);
  });

  it("reflects folded notes and compacted messages rather than the original history", async () => {
    const full: ModelMessage[] = [
      { role: "user", content: "goal\n[dynamic context]" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read",
            output: { type: "text", value: "x".repeat(80_000) },
          },
        ],
      },
    ];
    const compacted: ModelMessage[] = [full[0]!, { role: "user", content: "[read result stub id=read]" }];
    const measure = await createPromptMeasurer("", {});
    expect(measure(compacted).messagesChars).toBeLessThan(100);
    expect(measure(full).messagesChars).toBeGreaterThan(80_000);
  });
});
