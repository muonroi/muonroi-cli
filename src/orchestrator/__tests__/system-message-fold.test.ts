import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { FOLDED_SYSTEM_PREFIX, foldMidConversationSystemMessages } from "../system-message-fold.js";

const previousTurn: ModelMessage[] = [
  { role: "system", content: "leading contract" },
  { role: "user", content: "build the parser" },
  { role: "assistant", content: "dispatched a worker" },
];

describe("foldMidConversationSystemMessages — prompt-cache prefix", () => {
  it("folds a notice that precedes the next user message FORWARD, so the new request is a pure append", () => {
    const before = foldMidConversationSystemMessages(previousTurn);
    const after = foldMidConversationSystemMessages([
      ...previousTurn,
      { role: "system", content: "Background agent complete: `w`" },
      { role: "user", content: "[background jobs finished]" },
    ]);
    // Every message of the previous request is byte-identical in the next one.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toEqual({
      role: "user",
      content: `${FOLDED_SYSTEM_PREFIX}\nBackground agent complete: \`w\`\n\n[background jobs finished]`,
    });
    expect(after.some((m, i) => i > 0 && m.role === "system")).toBe(false);
  });

  it("keeps several notices in order and prepends them to structured content", () => {
    const out = foldMidConversationSystemMessages([
      ...previousTurn,
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    expect(out.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: `${FOLDED_SYSTEM_PREFIX}\nfirst\n\n${FOLDED_SYSTEM_PREFIX}\nsecond` },
        { type: "text", text: "next" },
      ],
    });
  });

  it("still folds a mid-turn notice (no later user message) into the preceding user message", () => {
    const out = foldMidConversationSystemMessages([...previousTurn, { role: "system", content: "mid-turn note" }]);
    expect(out).toHaveLength(previousTurn.length);
    expect(out[1]).toEqual({ role: "user", content: `build the parser\n\n${FOLDED_SYSTEM_PREFIX}\nmid-turn note` });
  });

  it("leaves leading system messages and inputs without a mid-conversation system message untouched", () => {
    expect(foldMidConversationSystemMessages(previousTurn)).toBe(previousTurn);
    const orphan: ModelMessage[] = [
      { role: "assistant", content: "a" },
      { role: "system", content: "no user anywhere" },
    ];
    expect(foldMidConversationSystemMessages(orphan)).toEqual(orphan);
  });
});
