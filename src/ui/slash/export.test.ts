import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolResult } from "../../types/index.js";

vi.mock("../../index.js", () => ({ appendCrashLog: vi.fn() }));
vi.mock("../../storage/transcript.js", () => ({ buildChatEntries: vi.fn() }));
vi.mock("../../storage/db.js", () => ({ getDatabase: () => ({ prepare: () => ({ all: () => [] }) }) }));

import { buildChatEntries } from "../../storage/transcript.js";
import { handleExportSlash } from "./export.js";

const timestamp = new Date("2026-10-14T10:00:00Z");
const assistant = (content: string): ChatEntry => ({ type: "assistant", content, timestamp });
const tool = (id: string, result: ToolResult): ChatEntry => ({
  type: "tool_result",
  content: result.success ? result.output || "Success" : result.error || "Error",
  timestamp,
  toolCall: { id, type: "function", function: { name: "read_file", arguments: "{}" } },
  toolResult: result,
});
const group = (entries: ChatEntry[]): ChatEntry => ({
  type: "tool_group",
  content: "",
  timestamp,
  toolGroup: {
    id: "group",
    state: "done",
    startedAt: timestamp.getTime(),
    items: entries.map((entry) => ({
      toolCall: entry.toolCall!,
      result: entry.toolResult,
      startedAt: timestamp.getTime(),
    })),
  },
});

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-export-test-"));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function exportChat(db: ChatEntry[], live: ChatEntry[]) {
  vi.mocked(buildChatEntries).mockReturnValue(db);
  const message = await handleExportSlash([], {
    cwd,
    tenantId: "test",
    defaultProvider: "fixture",
    defaultModel: "fixture",
    sessionId: "export-test",
    getLiveEntries: () => live,
  });
  return { message, text: fs.readFileSync(path.join(cwd, "chat-export-export-test.txt"), "utf8") };
}

describe("chat export content comparison", () => {
  it("exports equivalent grouped and flat tools once without a divergence warning", async () => {
    const first = tool("one", { success: true, output: "FIRST_TOOL_OUTPUT" });
    const second = tool("two", { success: false, error: "SECOND_TOOL_ERROR" });
    const grouped = group([first, second]);
    grouped.toolGroup!.items[0]!.startedAt -= 30_000;
    const { message, text } = await exportChat([first, second, assistant("done")], [grouped, assistant("done")]);
    expect(message).toContain("DB and TUI matched");
    expect(text).not.toContain("WARNING");
    expect(text.match(/FIRST_TOOL_OUTPUT/g)).toHaveLength(1);
    expect(text).toContain("SECOND_TOOL_ERROR");
  });

  it("retains both sources when equal row counts hide different answers", async () => {
    const { message, text } = await exportChat([assistant("DB ANSWER")], [assistant("LIVE ANSWER")]);
    expect(message).toContain("diverged");
    expect(text).toContain("Section A: Persisted");
    expect(text).toContain("Section B: Live");
    expect(text).toContain("DB ANSWER");
    expect(text).toContain("LIVE ANSWER");
  });

  it("includes grouped tool errors and edit diffs when only live entries are available", async () => {
    const edited = tool("edit", {
      success: true,
      output: "edited",
      diff: { filePath: "owned.txt", additions: 1, removals: 1, patch: "-before\n+after", isNew: false },
    });
    edited.toolCall!.function.name = "edit_file";
    const failed = tool("failed", { success: false, error: "LIVE_TOOL_ERROR" });
    const { text } = await exportChat([], [group([edited, failed])]);
    expect(text).toContain("Tool [edit_file]");
    expect(text).toContain("```diff\n-before\n+after\n```");
    expect(text).toContain("LIVE_TOOL_ERROR");
  });

  it("retains full background wake prompts and their different display labels", async () => {
    const db: ChatEntry = { type: "user", content: "[background jobs finished]\nFull job result", timestamp };
    const live: ChatEntry = { type: "user", content: "⟲ background job finished — resuming", timestamp };
    const { text } = await exportChat([db], [live]);
    expect(text).toContain("WARNING");
    expect(text).toContain("Full job result");
    expect(text).toContain(live.content);
  });

  it("keeps a richer live edit patch even when the result text matches the DB", async () => {
    const db = tool("edit", { success: true, output: "edited" });
    db.toolCall!.function.name = "edit_file";
    const live = {
      ...db,
      toolResult: {
        ...db.toolResult!,
        diff: { filePath: "owned.txt", additions: 1, removals: 0, patch: "+LIVE_PATCH", isNew: false },
      },
    };
    const { message, text } = await exportChat([db], [group([live])]);
    expect(message).toContain("diverged");
    expect(text).toContain("+LIVE_PATCH");
  });

  it("retains pending tool calls when a live group has not received a result", async () => {
    const pending = group([tool("pending", { success: true })]);
    pending.toolGroup!.state = "active";
    pending.toolGroup!.items[0]!.result = undefined;
    pending.toolGroup!.items[0]!.toolCall.function.arguments = '{"file_path":"PENDING_FILE"}';
    const { text } = await exportChat([], [pending]);
    expect(text).toContain("tool_call:");
    expect(text).toContain("PENDING_FILE");
  });
});
