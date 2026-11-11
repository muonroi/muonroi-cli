import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  refreshSubSessionToolContract,
  SUB_SESSION_COMPLETION_RULE,
  SUB_SESSION_TOOL_BOUNDARY,
} from "../sub-session-tool-contract.js";

const prefix = "You are executing a sub-task delegated by the Main Session in an isolated, temporary Sub-Session.\n";
const legacy =
  "3. Once the goal is achieved and verified, you MUST return your final response using the 'respond_general' (or final answer) tool.";

describe("legacy sub-session tool contract projection", () => {
  it("changes only exact host instruction lines without mutating messages or sequence alignment", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: `${prefix}Assignment: preserve evidence\n${legacy}\nRemaining policies` },
    ];
    const before = structuredClone(messages);
    const projected = refreshSubSessionToolContract(messages);
    expect(projected).toHaveLength(messages.length);
    expect(projected[0]?.content).toBe(
      `${prefix}Assignment: preserve evidence\n${SUB_SESSION_COMPLETION_RULE}\nRemaining policies`,
    );
    expect(messages).toEqual(before);
  });

  it("preserves user/assistant quotations and unrelated system policies by identity", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: prefix + legacy },
      { role: "assistant", content: prefix + legacy },
      { role: "system", content: `Repository instruction\n${legacy}` },
      { role: "system", content: `${prefix}Quoted example: ${legacy}` },
    ];
    const projected = refreshSubSessionToolContract(messages);
    messages.forEach((message, index) => {
      expect(projected[index]).toBe(message);
    });
  });

  it("is idempotent for the current contract and preserves message metadata", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `${prefix}${SUB_SESSION_TOOL_BOUNDARY}\n${SUB_SESSION_COMPLETION_RULE}`,
        providerOptions: { fixture: { cache: true } },
      },
    ];
    expect(refreshSubSessionToolContract(messages)[0]).toBe(messages[0]);
  });
});
