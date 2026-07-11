import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCall, ToolResult } from "../../types/index";

const sessionsDb = new Map<string, { parent_session_id: string | null }>();
const messagesDb = new Map<string, Array<{ seq: number; role: string; message_json: string; created_at: string }>>();
const toolCallsDb = new Map<
  string,
  Array<{ id: number; tool_call_id: string; tool_name: string; args_json: string }>
>();
const toolResultsDb = new Map<string, Array<{ tool_call_id: string; output_json: string }>>();
const compactionsDb = new Map<
  string,
  { first_kept_seq: number; summary: string; tokens_before: number; created_at: string }
>();

vi.mock("../db", () => {
  return {
    getDatabase: () => ({
      prepare: (sql: string) => {
        const lower = sql.toLowerCase();
        return {
          get: (param: string) => {
            if (lower.includes("from sessions")) {
              if (lower.includes("where parent_session_id =")) {
                for (const [id, val] of sessionsDb.entries()) {
                  if (val.parent_session_id === param) {
                    return { id };
                  }
                }
                return undefined;
              }
              return sessionsDb.get(param) || { parent_session_id: null };
            }
            if (lower.includes("from tool_calls") && lower.includes("todo_write")) {
              const calls = toolCallsDb.get(param) || [];
              const todo = calls.find((c) => c.tool_name === "todo_write");
              return todo ? { args_json: todo.args_json } : undefined;
            }
            if (lower.includes("from compactions")) {
              return compactionsDb.get(param);
            }
            return undefined;
          },
          all: (...params: any[]) => {
            if (lower.includes("from messages")) {
              return messagesDb.get(params[0]) || [];
            }
            if (lower.includes("from tool_results")) {
              return toolResultsDb.get(params[0]) || [];
            }
            if (lower.includes("from sessions")) {
              if (lower.includes("where parent_session_id =")) {
                const results: Array<{ id: string }> = [];
                for (const [id, val] of sessionsDb.entries()) {
                  if (val.parent_session_id === params[0]) {
                    results.push({ id });
                  }
                }
                return results;
              }
              if (lower.includes("where id in")) {
                return params.map((id) => ({ id }));
              }
            }
            return [];
          },
          run: () => ({ changes: 0 }),
        };
      },
      exec: () => undefined,
      pragma: () => undefined,
      transaction: <T>(fn: () => T) => fn,
    }),
    withTransaction: <T>(fn: (db: any) => T) => fn({} as any),
  };
});

import {
  buildChatEntries,
  getLastTodoWriteArgs,
  getSessionChain,
  loadSessionChainTranscriptState,
} from "../transcript";

describe("Hierarchical Sessions (Silent Rotation Support)", () => {
  beforeEach(() => {
    sessionsDb.clear();
    messagesDb.clear();
    toolCallsDb.clear();
    toolResultsDb.clear();
    compactionsDb.clear();
  });

  describe("getSessionChain", () => {
    it("returns correct chain for a single session", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      expect(getSessionChain("sessionA")).toEqual(["sessionA"]);
    });

    it("traverses up the parent session chain recursively", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });
      sessionsDb.set("sessionC", { parent_session_id: "sessionB" });

      expect(getSessionChain("sessionC")).toEqual(["sessionA", "sessionB", "sessionC"]);
    });

    it("handles loops gracefully and does not infinite loop", () => {
      sessionsDb.set("sessionA", { parent_session_id: "sessionB" });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      // Should break loop and return traversed list in some order
      const chain = getSessionChain("sessionB");
      expect(chain.length).toBe(2);
      expect(chain).toContain("sessionA");
      expect(chain).toContain("sessionB");
    });

    it("walks nested descendants (parent -> child -> grandchild)", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });
      sessionsDb.set("sessionC", { parent_session_id: "sessionB" });

      expect(getSessionChain("sessionA")).toEqual(["sessionA", "sessionB", "sessionC"]);
      expect(getSessionChain("sessionC")).toEqual(["sessionA", "sessionB", "sessionC"]);
    });
  });

  describe("getLastTodoWriteArgs", () => {
    it("returns null if no todo_write exists in chain", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      expect(getLastTodoWriteArgs("sessionA")).toBeNull();
    });

    it("retrieves todo_write arguments from the current session", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      toolCallsDb.set("sessionA", [
        { id: 1, tool_call_id: "call_1", tool_name: "todo_write", args_json: '{"items":[]}' },
      ]);

      expect(getLastTodoWriteArgs("sessionA")).toBe('{"items":[]}');
    });

    it("retrieves todo_write arguments recursively from parent session", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      toolCallsDb.set("sessionA", [
        { id: 1, tool_call_id: "call_1", tool_name: "todo_write", args_json: '{"items":["task1"]}' },
      ]);
      // sessionB has no todo_write calls

      expect(getLastTodoWriteArgs("sessionB")).toBe('{"items":["task1"]}');
    });
  });

  describe("buildChatEntries", () => {
    it("merges messages from parent and child session chronologically", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
        {
          seq: 2,
          role: "assistant",
          message_json: JSON.stringify({ role: "assistant", content: "Reply A" }),
          created_at: "2026-06-25T12:01:00Z",
        },
      ]);

      messagesDb.set("sessionB", [
        {
          seq: 1,
          role: "system",
          // compaction summary (should be skipped since it's the first message of a child)
          message_json: JSON.stringify({ role: "system", content: "[Context checkpoint summary]\nEarlier work" }),
          created_at: "2026-06-25T12:02:00Z",
        },
        {
          seq: 2,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello B" }),
          created_at: "2026-06-25T12:03:00Z",
        },
      ]);

      const entries = buildChatEntries("sessionB");
      expect(entries.length).toBe(3);
      expect(entries[0]).toEqual(expect.objectContaining({ type: "user", content: "Hello A" }));
      expect(entries[1]).toEqual(expect.objectContaining({ type: "assistant", content: "Reply A" }));
      expect(entries[2]).toEqual(expect.objectContaining({ type: "user", content: "Hello B" }));
    });
  });

  describe("loadSessionChainTranscriptState", () => {
    it("returns only the requested session state when there are no children", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
      ]);

      const state = loadSessionChainTranscriptState("sessionA");
      expect(state.messages).toHaveLength(1);
      expect(state.seqs).toEqual([1]);
    });

    it("merges parent and child messages chronologically and nulls child seqs", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
        {
          seq: 2,
          role: "assistant",
          message_json: JSON.stringify({ role: "assistant", content: "Reply A" }),
          created_at: "2026-06-25T12:01:00Z",
        },
      ]);

      messagesDb.set("sessionB", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello B" }),
          created_at: "2026-06-25T12:02:00Z",
        },
      ]);

      const state = loadSessionChainTranscriptState("sessionA");
      expect(state.messages.map((m) => (m as any).content)).toEqual(["Hello A", "Reply A", "Hello B"]);
      expect(state.seqs).toEqual([1, 2, null]);
    });

    it("keeps seqs for the resumed session and nulls ancestor seqs when resuming a child", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
      ]);
      messagesDb.set("sessionB", [
        {
          seq: 1,
          role: "assistant",
          message_json: JSON.stringify({ role: "assistant", content: "Reply B" }),
          created_at: "2026-06-25T12:01:00Z",
        },
      ]);

      const state = loadSessionChainTranscriptState("sessionB");
      expect(state.messages.map((m) => (m as any).content)).toEqual(["Hello A", "Reply B"]);
      expect(state.seqs).toEqual([null, 1]);
    });

    it("merges a nested chain (parent -> child -> grandchild)", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });
      sessionsDb.set("sessionC", { parent_session_id: "sessionB" });

      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
      ]);
      messagesDb.set("sessionB", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello B" }),
          created_at: "2026-06-25T12:01:00Z",
        },
      ]);
      messagesDb.set("sessionC", [
        {
          seq: 1,
          role: "assistant",
          message_json: JSON.stringify({ role: "assistant", content: "Reply C" }),
          created_at: "2026-06-25T12:02:00Z",
        },
      ]);

      const state = loadSessionChainTranscriptState("sessionA");
      expect(state.messages.map((m) => (m as any).content)).toEqual(["Hello A", "Hello B", "Reply C"]);
      expect(state.seqs).toEqual([1, null, null]);
    });

    it("applies each session's compaction before merging", () => {
      sessionsDb.set("sessionA", { parent_session_id: null });
      sessionsDb.set("sessionB", { parent_session_id: "sessionA" });

      messagesDb.set("sessionA", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Old A" }),
          created_at: "2026-06-25T12:00:00Z",
        },
        {
          seq: 2,
          role: "assistant",
          message_json: JSON.stringify({ role: "assistant", content: "Reply A" }),
          created_at: "2026-06-25T12:01:00Z",
        },
      ]);
      compactionsDb.set("sessionA", {
        first_kept_seq: 2,
        summary: "Compacted A",
        tokens_before: 100,
        created_at: "2026-06-25T12:01:30Z",
      });

      messagesDb.set("sessionB", [
        {
          seq: 1,
          role: "user",
          message_json: JSON.stringify({ role: "user", content: "Hello B" }),
          created_at: "2026-06-25T12:02:00Z",
        },
      ]);

      const state = loadSessionChainTranscriptState("sessionA");
      const contents = state.messages.map((m) => (m as any).content);
      expect(contents[0]).toContain("Compacted A");
      expect(contents).toContain("Reply A");
      expect(contents).toContain("Hello B");
      expect(contents).not.toContain("Old A");
    });
  });
});
