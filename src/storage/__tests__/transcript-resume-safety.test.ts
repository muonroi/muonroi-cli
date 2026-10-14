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

  it("preserves long opaque thinking signatures when resuming a large assistant message", () => {
    const signature = "A".repeat(4096);
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: { anthropic: { signature } } },
        { type: "text", text: "Long answer ".repeat(6000) },
      ],
    };
    messagesDb.set("thinking-resume", [
      {
        session_id: "thinking-resume",
        seq: 1,
        role: "assistant",
        message_json: JSON.stringify(message),
        created_at: "2026-10-08T04:00:00Z",
      },
    ]);
    const loaded = loadRawTranscript("thinking-resume");
    expect(loaded).toEqual([message]);
  });

  it("still removes historical oversized image bytes from tool results on resume", () => {
    const image = "A".repeat(4096);
    messagesDb.set("image-resume", [
      {
        session_id: "image-resume",
        seq: 1,
        role: "assistant",
        created_at: "2026-10-08T04:00:00Z",
        message_json: JSON.stringify({
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "image1", toolName: "screenshot", input: {} }],
        }),
      },
      {
        session_id: "image-resume",
        seq: 2,
        role: "tool",
        created_at: "2026-10-08T04:00:01Z",
        message_json: JSON.stringify({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "image1",
              toolName: "screenshot",
              output: { type: "json", value: { data: image, text: "Description ".repeat(6000) } },
            },
          ],
        }),
      },
    ]);
    const loaded = JSON.stringify(loadRawTranscript("image-resume"));
    expect(loaded).not.toContain(image);
    expect(loaded).toContain("[image data removed on resume]");
    expect(loaded).toContain("Description");
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

/**
 * Round 10 (G8 HIGH B) — round 9's per-row skip made resume survive a
 * malformed row, but left the SURVIVING messages internally inconsistent:
 * exact repro measured — a malformed assistant message carrying a
 * `tool-call` part gets skipped (round 9), but the `tool` role message
 * carrying ITS result is itself well-formed and survives, leaving
 * `[user, tool, user]` with a `toolCallId` the provider has never seen an
 * assistant declare. Every OpenAI-compatible provider rejects that shape —
 * measured: a 400 on the very next call. `sanitizeToolCallPairing` fixes
 * both directions after loading.
 */
describe("transcript resume safety — round 10 (G8 HIGH B): orphaned tool-call/tool-result pairing", () => {
  beforeEach(() => {
    sessionsDb.clear();
    messagesDb.clear();
    compactionsDb.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("EXACT REPRO: a malformed assistant tool-call row is skipped, and its surviving tool-result row is dropped too — never [user, tool, user]", () => {
    sessionsDb.set("sess-3", { parent_session_id: null });
    messagesDb.set("sess-3", [
      {
        session_id: "sess-3",
        seq: 1,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "start" }),
        created_at: "2026-01-01T00:00:00Z",
      },
      // The assistant message that DECLARED tool call "tc-1" is malformed
      // and gets skipped by round 9's parseMessageRowsSafely.
      {
        session_id: "sess-3",
        seq: 2,
        role: "assistant",
        message_json: '{"role":"assistant","content":[{"type":"tool-call","toolCallId":"tc-1"',
        created_at: "2026-01-01T00:00:01Z",
      },
      // Its tool-result row is itself perfectly well-formed and survives.
      {
        session_id: "sess-3",
        seq: 3,
        role: "tool",
        message_json: JSON.stringify({
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "tc-1", toolName: "read_file", output: { type: "text", value: "ok" } },
          ],
        }),
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        session_id: "sess-3",
        seq: 4,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "continue" }),
        created_at: "2026-01-01T00:00:03Z",
      },
    ]);
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const state = loadTranscriptState("sess-3");

    // The orphaned tool-result (seq 3) is gone — no [user, tool, user] shape
    // with a toolCallId no assistant ever declared.
    expect(state.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(state.messages.map((m) => m.content)).toEqual(["start", "continue"]);
    expect(state.seqs).toEqual([1, 4]);
    expect(warnSpy).toHaveBeenCalledWith(
      "storage",
      "Sanitized orphaned tool-call/tool-result pairing on resume",
      expect.objectContaining({ droppedResults: 1 }),
    );
  });

  it("an assistant tool-call with NO matching result anywhere gets a synthetic result inserted right after it", () => {
    sessionsDb.set("sess-4", { parent_session_id: null });
    messagesDb.set("sess-4", [
      {
        session_id: "sess-4",
        seq: 1,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "start" }),
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        session_id: "sess-4",
        seq: 2,
        role: "assistant",
        message_json: JSON.stringify({
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc-2", toolName: "read_file", input: { path: "x.ts" } }],
        }),
        created_at: "2026-01-01T00:00:01Z",
      },
      // No tool-result row for tc-2 anywhere (dropped/never persisted).
      {
        session_id: "sess-4",
        seq: 3,
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "continue" }),
        created_at: "2026-01-01T00:00:02Z",
      },
    ]);
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const state = loadTranscriptState("sess-4");

    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const synthetic = state.messages[2]! as { content: Array<{ toolCallId: string; type: string }> };
    expect(Array.isArray(synthetic.content)).toBe(true);
    expect(synthetic.content[0]?.toolCallId).toBe("tc-2");
    expect(synthetic.content[0]?.type).toBe("tool-result");
    // The synthetic message has no persisted seq — it never existed as a row.
    expect(state.seqs).toEqual([1, 2, null, 3]);
    expect(warnSpy).toHaveBeenCalledWith(
      "storage",
      "Sanitized orphaned tool-call/tool-result pairing on resume",
      expect.objectContaining({ synthesizedResults: 1 }),
    );
  });

  it("a well-paired transcript (normal case) is left completely untouched — no false positives", () => {
    sessionsDb.set("sess-5", { parent_session_id: null });
    messagesDb.set("sess-5", [
      {
        session_id: "sess-5",
        seq: 1,
        role: "assistant",
        message_json: JSON.stringify({
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc-3", toolName: "read_file", input: { path: "y.ts" } }],
        }),
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        session_id: "sess-5",
        seq: 2,
        role: "tool",
        message_json: JSON.stringify({
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "tc-3", toolName: "read_file", output: { type: "text", value: "ok" } },
          ],
        }),
        created_at: "2026-01-01T00:00:01Z",
      },
    ]);
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const state = loadTranscriptState("sess-5");

    expect(state.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(state.seqs).toEqual([1, 2]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      "storage",
      "Sanitized orphaned tool-call/tool-result pairing on resume",
      expect.anything(),
    );
  });
});
