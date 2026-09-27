/**
 * Round 9 (G11c) — a single malformed `message_json` row must not take down
 * the WHOLE session resume. Measured live (session d331c42cea14): a
 * sub-session's turn aborted mid-stream (a `ToolCallMarkupLeakError`
 * propagating uncaught out of an unguarded compaction summary call — see
 * G11a/compact-summary-failure.test.ts), and the NEXT top-level turn on the
 * resumed parent session failed instantly with a raw, uncustomized
 * `JSON Parse error: Expected ']'` (a truncated JSON array — every row this
 * session ever persisted parsed cleanly on inspection, so the malformed JSON
 * was constructed transiently during that turn's own processing, not
 * corrupted at rest — the exact call site could not be pinned down from the
 * available forensics). Regardless of which future turn produces a bad row,
 * resuming a session must survive it: `transcript.ts`'s message loaders now
 * parse each row independently and OMIT one that fails to parse, instead of
 * throwing and aborting the whole resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionsDb = new Map<string, { parent_session_id: string | null }>();
const messagesDb = new Map<
  string,
  Array<{ session_id: string; seq: number; role: string; message_json: string; created_at: string }>
>();
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
              return sessionsDb.get(param) || { parent_session_id: null };
            }
            if (lower.includes("from compactions")) {
              return compactionsDb.get(param);
            }
            return undefined;
          },
          all: (...params: unknown[]) => {
            if (lower.includes("from messages")) {
              return messagesDb.get(params[0] as string) || [];
            }
            if (lower.includes("from sessions")) {
              if (lower.includes("where parent_session_id =")) {
                const results: Array<{ id: string }> = [];
                for (const [id, val] of sessionsDb.entries()) {
                  if (val.parent_session_id === params[0]) results.push({ id });
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
    withTransaction: <T>(fn: (db: unknown) => T) => fn({} as unknown),
  };
});

import { logger } from "../../utils/logger.js";
import { loadRawTranscript, loadSessionChainTranscriptState, loadTranscriptState } from "../transcript";

describe("transcript resume safety — round 9 (G11c)", () => {
  beforeEach(() => {
    sessionsDb.clear();
    messagesDb.clear();
    compactionsDb.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadTranscriptState skips an unparseable row and keeps every valid one, without throwing", () => {
    sessionsDb.set("sess-1", { parent_session_id: null });
    messagesDb.set("sess-1", [
      {
        session_id: "sess-1",
        seq: 1,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "hi" }),
        created_at: "2026-01-01T00:00:00Z",
      },
      // Truncated JSON array — exactly the "Expected ']'" shape measured live.
      {
        session_id: "sess-1",
        seq: 2,
        role: "assistant",
        message_json: '{"role":"assistant","content":["oops"',
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        session_id: "sess-1",
        seq: 3,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "still here?" }),
        created_at: "2026-01-01T00:00:02Z",
      },
    ]);

    const warnSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    let state: ReturnType<typeof loadTranscriptState> | undefined;
    expect(() => {
      state = loadTranscriptState("sess-1");
    }).not.toThrow();

    expect(state!.messages).toHaveLength(2);
    expect(state!.messages.map((m) => m.content)).toEqual(["hi", "still here?"]);
    expect(state!.seqs).toEqual([1, 3]);

    // The bad row is logged for forensics (session + seq), not silently dropped.
    expect(warnSpy).toHaveBeenCalledWith(
      "storage",
      expect.stringContaining("Skipping unparseable message row"),
      expect.objectContaining({ sessionId: "sess-1", seq: 2 }),
    );
  });

  it("loadRawTranscript is equally safe", () => {
    sessionsDb.set("sess-2", { parent_session_id: null });
    messagesDb.set("sess-2", [
      {
        session_id: "sess-2",
        seq: 1,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "a" }),
        created_at: "2026-01-01T00:00:00Z",
      },
      { session_id: "sess-2", seq: 2, role: "user", message_json: "[1,2,3", created_at: "2026-01-01T00:00:01Z" },
    ]);
    vi.spyOn(logger, "error").mockImplementation(() => {});

    const messages = loadRawTranscript("sess-2");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("a");
  });

  it("loadSessionChainTranscriptState is equally safe across a multi-session chain", () => {
    sessionsDb.set("parent", { parent_session_id: null });
    sessionsDb.set("child", { parent_session_id: "parent" });
    messagesDb.set("parent", [
      {
        session_id: "parent",
        seq: 1,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "parent msg" }),
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    messagesDb.set("child", [
      {
        session_id: "child",
        seq: 1,
        role: "assistant",
        message_json: '{"role":"assistant","content":["broken"',
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        session_id: "child",
        seq: 2,
        role: "assistant",
        message_json: JSON.stringify({ role: "assistant", content: "child msg" }),
        created_at: "2026-01-01T00:00:02Z",
      },
    ]);
    vi.spyOn(logger, "error").mockImplementation(() => {});

    let state: ReturnType<typeof loadSessionChainTranscriptState> | undefined;
    expect(() => {
      state = loadSessionChainTranscriptState("child");
    }).not.toThrow();

    expect(state!.messages.map((m) => m.content)).toEqual(["parent msg", "child msg"]);
  });
});
