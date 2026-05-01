import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { compressChat } from "../compress.js";

// Mock the existing compaction engine
vi.mock("../../../orchestrator/compaction.js", () => ({
  serializeConversation: (msgs: ModelMessage[]) => {
    // Simple serialization for tests
    return msgs
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : "";
        return `[${m.role}]: ${text}`;
      })
      .join("\n\n");
  },
  estimateMessageTokens: (msg: ModelMessage) => {
    const text = typeof msg.content === "string" ? msg.content : "";
    return Math.ceil(text.length / 4);
  },
  prepareCompaction: vi.fn().mockReturnValue(null),
  generateCompactionSummary: vi.fn().mockResolvedValue("Compressed summary"),
  DEFAULT_RESERVE_TOKENS: 16_384,
  DEFAULT_KEEP_RECENT_TOKENS: 20_000,
}));

describe("compressChat", () => {
  const shortMessages: ModelMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ];

  it("returns messages unchanged when under token budget", async () => {
    const result = await compressChat(shortMessages, "system prompt", 10000);
    expect(result.summary).toContain("Hello");
    expect(result.summary).toContain("Hi there");
    expect(result.tokensAfter).toBeLessThanOrEqual(10000);
  });

  it("preserves <!-- preserve --> blocks verbatim in output", async () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Some chat\n<!-- preserve -->\nCritical verbatim block\n<!-- /preserve -->\nMore chat",
      },
    ];
    const result = await compressChat(messages, "system", 10000);
    expect(result.summary).toContain("<!-- preserve -->");
    expect(result.summary).toContain("Critical verbatim block");
    expect(result.summary).toContain("<!-- /preserve -->");
  });

  it("returns preservedBlocks array", async () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Text\n<!-- preserve -->\nBlock content\n<!-- /preserve -->\nRest",
      },
    ];
    const result = await compressChat(messages, "system", 10000);
    expect(result.preservedBlocks).toHaveLength(1);
    expect(result.preservedBlocks[0].content).toBe("\nBlock content\n");
  });

  it("returns estimated tokensAfter", async () => {
    const result = await compressChat(shortMessages, "system prompt", 10000);
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(typeof result.tokensAfter).toBe("number");
  });
});
