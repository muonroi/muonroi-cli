import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolGroupItem } from "../../../types/index.js";
import { internalActivityForDisplay, isInternalActivityTool } from "../internal-activity.js";
import { findLastCollapsibleIndex } from "../../components/message-view.js";

const item = (name: string, failed = false): ToolGroupItem => ({
  toolCall: { id: name, type: "function", function: { name, arguments: "{}" } },
  result: { success: !failed, output: "RAW_EVIDENCE", ...(failed ? { error: "RAW_FAILURE" } : {}) },
  failed,
  startedAt: 1,
  finishedAt: 2,
});
const group = (items: ToolGroupItem[]): ChatEntry => ({
  type: "tool_group",
  content: "",
  timestamp: new Date(),
  toolGroup: { id: "g", state: "failed", items, startedAt: 1, finishedAt: 2 },
});

describe("quiet internal activity is display-only", () => {
  it.each([
    "task",
    "delegate",
    "delegation_read",
    "delegation_ack",
    "delegation_accept",
    "ee_query",
    "ee_write",
    "ee_feedback",
    "worker_models",
    "convene_council",
    "flow_plan_review",
  ])("hides %s cards including failures", (name) => {
    const evidence = item(name, true);
    const entry: ChatEntry = {
      type: "tool_result",
      timestamp: new Date(),
      content: "RAW_EVIDENCE",
      toolCall: evidence.toolCall,
      toolResult: evidence.result,
    };
    expect(internalActivityForDisplay(entry)).toBeNull();
    expect(entry.toolResult?.error).toBe("RAW_FAILURE");
  });
  it.each(["read_file", "bash", "edit_file", "ask_user", "my_ee_report"])("keeps ordinary or consent tool %s", (name) =>
    expect(isInternalActivityTool(name)).toBe(false));
  it("hides tagged host notices without deleting them", () => {
    const entry: ChatEntry = {
      type: "assistant",
      content: "exact full receipt",
      timestamp: new Date(),
      internal: true,
    };
    expect(internalActivityForDisplay(entry)).toBeNull();
    expect(entry.content).toBe("exact full receipt");
  });
  it.each(["user", "assistant"] as const)("never matches internal-looking %s prose", (type) => {
    const entry: ChatEntry = {
      type,
      content: "Background agent complete: worker\nEE brain done; delegation_ack",
      timestamp: new Date(),
    };
    expect(internalActivityForDisplay(entry)).toBe(entry);
  });
  it("removes hidden calls/counts/failure state from a mixed group without mutating raw evidence", () => {
    const entry = group([item("ee_query", true), item("read_file")]);
    const before = JSON.stringify(entry);
    const display = internalActivityForDisplay(entry)!;
    expect(display.toolGroup?.items.map((i) => i.toolCall.function.name)).toEqual(["read_file"]);
    expect(display.toolGroup?.state).toBe("done");
    expect(JSON.stringify(entry)).toBe(before);
    expect(entry.toolGroup?.state).toBe("failed");
  });
  it("retains an actual visible failure and skips all-internal Ctrl+E targets", () => {
    const visible = group([item("bash", true), item("delegation_ack")]);
    expect(internalActivityForDisplay(visible)?.toolGroup?.state).toBe("failed");
    const hidden = group([item("ee_query")]);
    expect(internalActivityForDisplay(hidden)).toBeNull();
    expect(findLastCollapsibleIndex([visible, hidden])).toBe(-1);
    const done = group([item("read_file")]);
    done.toolGroup!.state = "done";
    expect(findLastCollapsibleIndex([done, hidden])).toBe(0);
  });
});
