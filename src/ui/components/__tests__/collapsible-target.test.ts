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

  // Prose no longer auto-collapses, so a long message advertises no ctrl+e
  // affordance and must NOT be a target — otherwise ctrl+e selects an entry with
  // nothing to toggle and swallows the key.
  it("ignores a long user message (user prose renders in full)", () => {
    expect(findLastCollapsibleIndex([user(2), user(9)])).toBe(-1);
  });

  it("ignores a long assistant body (assistant prose renders in full)", () => {
    expect(findLastCollapsibleIndex([assistant(40)])).toBe(-1);
  });

  it("targets a done tool group even when a long user message sits above it", () => {
    expect(findLastCollapsibleIndex([user(9), toolGroup("done", 3)])).toBe(1);
  });

  // The regression that prompted the change: every previous answer folded back
  // to 8 lines the moment a new turn started. Neither body is a target now.
  it("keeps earlier assistant answers un-targeted once a newer turn lands", () => {
    expect(findLastCollapsibleIndex([assistant(40), user(2), assistant(40)])).toBe(-1);
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

  // Reasoning is the one prose surface that still collapses, so it IS a target.
  it("targets an assistant carrying long reasoning", () => {
    expect(findLastCollapsibleIndex([assistant(20), assistant(2, 8)])).toBe(1);
  });

  it("ignores reasoning at exactly the collapse threshold", () => {
    expect(findLastCollapsibleIndex([assistant(2, 3)])).toBe(-1);
  });

  it("picks the newest target when several qualify", () => {
    expect(findLastCollapsibleIndex([toolGroup("done", 2), user(9), assistant(2, 8)])).toBe(2);
  });
});
