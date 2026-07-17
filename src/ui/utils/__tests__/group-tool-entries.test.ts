import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolCall, ToolResult } from "../../../types/index";
import { groupToolEntries } from "../group-tool-entries.js";

const call = (name: string, id = name): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

const result = (name: string, over: Partial<ToolResult> = {}, id = name): ChatEntry => ({
  type: "tool_result",
  content: "",
  timestamp: new Date(1000),
  toolCall: call(name, id),
  toolResult: { success: true, ...over },
});

const user = (content: string): ChatEntry => ({ type: "user", content, timestamp: new Date(1000) });
const assistant = (content: string): ChatEntry => ({ type: "assistant", content, timestamp: new Date(1000) });

describe("groupToolEntries", () => {
  // The reported bug: after the answer landed, the transcript resync dropped the
  // group and every tool became its own flat "→ <tool>" line.
  it("folds a run of tool results into one done group", () => {
    const out = groupToolEntries([user("go"), result("read_file", {}, "a"), result("bash", {}, "b"), assistant("ok")]);
    expect(out.map((e) => e.type)).toEqual(["user", "tool_group", "assistant"]);
    expect(out[1]?.toolGroup?.state).toBe("done");
    expect(out[1]?.toolGroup?.items).toHaveLength(2);
  });

  it("marks the group failed when any item failed", () => {
    const out = groupToolEntries([result("read_file", { success: false, error: "nope" })]);
    expect(out[0]?.toolGroup?.state).toBe("failed");
    expect(out[0]?.toolGroup?.items[0]?.failed).toBe(true);
  });

  it("groups a single call too — the recap is what stays visible", () => {
    const out = groupToolEntries([result("read_file")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("tool_group");
  });

  it("preserves transcript order across several runs", () => {
    const out = groupToolEntries([
      user("a"),
      result("read_file", {}, "1"),
      assistant("thinking"),
      result("grep", {}, "2"),
      result("bash", {}, "3"),
      assistant("done"),
    ]);
    expect(out.map((e) => e.type)).toEqual(["user", "tool_group", "assistant", "tool_group", "assistant"]);
    expect(out[3]?.toolGroup?.items).toHaveLength(2);
  });

  // Rich renderers (plans, sub-agents, images) must survive — a group item line
  // cannot show them.
  it("leaves rich results ungrouped and uses them as run boundaries", () => {
    const plan = result("generate_plan", { plan: { title: "p", steps: [] } as never }, "p");
    const out = groupToolEntries([result("read_file", {}, "1"), plan, result("bash", {}, "2")]);
    expect(out.map((e) => e.type)).toEqual(["tool_group", "tool_result", "tool_group"]);
  });

  it("keeps a task (sub-agent) result standalone", () => {
    const out = groupToolEntries([result("task", { task: { id: "t" } as never }, "t")]);
    expect(out[0]?.type).toBe("tool_result");
  });

  it("drops a pending tool_call adjacent to a run so it isn't shown twice", () => {
    const pending: ChatEntry = { type: "tool_call", content: "▣  read_file", timestamp: new Date(1000) };
    const out = groupToolEntries([result("read_file", {}, "1"), pending]);
    expect(out.map((e) => e.type)).toEqual(["tool_group"]);
  });

  it("is stable: the same transcript rebuilds to the same group id", () => {
    const entries = [result("read_file", {}, "1"), result("bash", {}, "2")];
    expect(groupToolEntries(entries)[0]?.toolGroup?.id).toBe(groupToolEntries(entries)[0]?.toolGroup?.id);
  });

  it("passes an empty transcript through", () => {
    expect(groupToolEntries([])).toEqual([]);
  });
});
