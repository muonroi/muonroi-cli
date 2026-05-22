import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";

describe("reasoning helpers", () => {
  it("detects encrypted reasoning markers", () => {
    expect(containsEncryptedReasoning("-----BEGIN PGP MESSAGE-----\nabc")).toBe(true);
    expect(containsEncryptedReasoning("normal reasoning text")).toBe(false);
  });

  it("removes encrypted reasoning from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "-----BEGIN PGP MESSAGE-----\nabc" },
          { type: "text", text: "Final answer" },
        ],
      },
    ] as ModelMessage[];

    expect(sanitizeModelMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    ]);
  });

  // Session 7dcf8fd7d6a4 regression: 57/100 assistant messages contained
  // inter-tool narration like "Let me check..." → "Now let me look at...". The
  // PIL L6 text-based ban is ignored by budget models, so strip structurally.
  describe("inter-tool narration stripping", () => {
    it("drops 'Let me X' text when followed by a tool-call in the same message", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the current GitHub Actions status." },
            { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "gh run list" } },
          ],
        },
      ] as ModelMessage[];

      const result = sanitizeModelMessages(messages);
      expect(result[0]?.content).toEqual([
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "gh run list" } },
      ]);
    });

    it("drops Vietnamese narration 'Tiếp theo tôi sẽ...' before tool-call", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Tiếp theo tôi sẽ kiểm tra log." },
            { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "x" } },
          ],
        },
      ] as ModelMessage[];

      const result = sanitizeModelMessages(messages);
      expect((result[0]?.content as unknown[]).length).toBe(1);
    });

    it("KEEPS final-answer text when there is no tool-call in the same message", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Let me explain — actually this IS my final answer." }],
        },
      ] as ModelMessage[];

      const result = sanitizeModelMessages(messages);
      expect(result).toEqual(messages); // unchanged
    });

    it("KEEPS non-narration text even when followed by a tool-call", () => {
      // E.g. agent quoted a finding before drilling deeper. We don't want to
      // strip substantive commentary — only the narration boilerplate.
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Failure is in cost-leak-b3-tui.spec.ts line 47." },
            { type: "tool-call", toolCallId: "c3", toolName: "read_file", input: { path: "spec" } },
          ],
        },
      ] as ModelMessage[];

      const result = sanitizeModelMessages(messages);
      expect(result).toEqual(messages); // text was substantive, kept
    });

    it("strips multiple narration text parts but keeps tool-calls intact", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the status." },
            { type: "tool-call", toolCallId: "c4", toolName: "bash", input: { command: "ls" } },
            { type: "text", text: "Now let me read the file." },
            { type: "tool-call", toolCallId: "c5", toolName: "read_file", input: { path: "x" } },
          ],
        },
      ] as ModelMessage[];

      const result = sanitizeModelMessages(messages);
      const content = result[0]?.content as Array<{ type: string }>;
      expect(content.every((p) => p.type === "tool-call")).toBe(true);
      expect(content.length).toBe(2);
    });
  });
});
