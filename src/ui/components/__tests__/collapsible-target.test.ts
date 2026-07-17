import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolGroup } from "../../../types/index";
import { findLastCollapsibleIndex } from "../message-view.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

const user = (n: number): ChatEntry => ({ type: "user", content: lines(n), timestamp: new Date() });
const assistant = (n: number, reasoningLines = 0): ChatEntry => ({
  type: "assistant",
  content: lines(n),
  timestamp: new Date(),
  ...(reasoningLines > 0 ? { reasoning: lines(reasoningLines) } : {}),
});
const toolGroup = (state: ToolGroup["state"], itemCount: number): ChatEntry => ({
  type: "tool_group",
  content: "",
  timestamp: new Date(),
  toolGroup: {
    id: "tg-1",
    state,
    startedAt: 0,
    items: Array.from({ length: itemCount }, (_, i) => ({
      toolCall: { id: `c${i}`, type: "function", function: { name: "grep", arguments: "{}" } },
      startedAt: 0,
    })),
  },
});

describe("findLastCollapsibleIndex", () => {
  it("returns -1 when nothing renders a ctrl+e affordance", () => {
    expect(findLastCollapsibleIndex([user(2), assistant(3)])).toBe(-1);
  });

  it("targets a long user message", () => {
    expect(findLastCollapsibleIndex([user(2), user(9)])).toBe(1);
  });

  it("ignores a user message at exactly the collapse threshold", () => {
    expect(findLastCollapsibleIndex([user(5)])).toBe(-1);
  });

  // The bug the user hit: the ONLY handler targeted the last *user* message, so
  // ctrl+e did nothing for a collapsed tool group / narration / reasoning.
  it("targets a done tool group even when a long user message sits above it", () => {
    expect(findLastCollapsibleIndex([user(9), toolGroup("done", 3)])).toBe(1);
  });

  it("skips an active tool group (it is already expanded, no affordance)", () => {
    expect(findLastCollapsibleIndex([toolGroup("active", 3)])).toBe(-1);
  });

  it("skips a failed tool group (always expanded, no affordance)", () => {
    expect(findLastCollapsibleIndex([toolGroup("failed", 3)])).toBe(-1);
  });

  it("skips an empty done group", () => {
    expect(findLastCollapsibleIndex([toolGroup("done", 0)])).toBe(-1);
  });

  // F7: the final assistant message renders its body in full, so it advertises
  // no body affordance — the long narration above it is the real target.
  it("skips the final assistant body and targets earlier narration", () => {
    expect(findLastCollapsibleIndex([assistant(20), assistant(20)])).toBe(0);
  });

  // ...but reasoning collapses even on the final message, so it IS a target.
  it("targets the final assistant when it carries long reasoning", () => {
    expect(findLastCollapsibleIndex([assistant(20), assistant(2, 8)])).toBe(1);
  });

  it("picks the newest target when several qualify", () => {
    expect(findLastCollapsibleIndex([user(9), toolGroup("done", 2), user(9)])).toBe(2);
  });
});
