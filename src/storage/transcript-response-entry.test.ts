/**
 * src/storage/transcript-response-entry.test.ts
 *
 * Regression: buildChatEntries must rebuild a `respond_*` tool-result as a
 * `structured_response` ChatEntry — NOT a bare `tool_result`.
 *
 * Why this matters (live repro, session 9d3d371ca1bd): the live stream yields
 * the terminal answer as a `structured_response` chunk (message-processor.ts),
 * which the UI renders as the answer block. But finalizeActiveTurn (app.tsx)
 * replaces the live message list with `getChatEntries()` → `buildChatEntries()`
 * on EVERY normal turn. If buildChatEntries rebuilt the persisted respond_*
 * tool-call/result pair as a generic tool_result, the rendered answer was
 * silently dropped the instant streaming ended — the user saw only the
 * "→ respond_general" indicator with no answer. This test pins the rebuild to
 * a structured_response entry so the persisted view matches the live view.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

interface Row {
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

let MESSAGE_ROWS: Row[] = [];

vi.mock("./db", () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      all: () => (sql.includes("FROM messages") ? MESSAGE_ROWS : []),
      get: () => undefined,
      run: () => undefined,
    }),
  }),
  withTransaction: <T>(fn: (db: unknown) => T) => fn({}),
}));

// Pass-through transcript view: no compaction in these fixtures, so the
// effective transcript is the raw message list unchanged.
vi.mock("./transcript-view", () => ({
  buildEffectiveTranscript: (messages: unknown[], seqs: unknown[], timestamps: unknown[]) => ({
    messages,
    seqs,
    timestamps,
  }),
}));

const { buildChatEntries } = await import("./transcript");

afterEach(() => {
  MESSAGE_ROWS = [];
});

function row(seq: number, role: string, content: unknown): Row {
  return {
    session_id: "s1",
    seq,
    role,
    message_json: JSON.stringify({ role, content }),
    created_at: "2026-06-09T07:27:38.420Z",
  };
}

describe("buildChatEntries — respond_* terminal answer", () => {
  it("rebuilds a respond_general tool-result as a structured_response entry", () => {
    const callId = "call-respond-1";
    MESSAGE_ROWS = [
      row(1, "user", "how does this CLI affect you?"),
      row(2, "assistant", [
        { type: "reasoning", text: "investigated, now answer" },
        { type: "tool-call", toolCallId: callId, toolName: "respond_general", input: { response: "The answer." } },
      ]),
      row(3, "tool", [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "respond_general",
          output: { type: "json", value: { response: "The answer." } },
        },
      ]),
    ];

    const entries = buildChatEntries("s1");
    const sr = entries.find((e) => e.type === "structured_response");
    expect(sr).toBeDefined();
    expect(sr?.structuredResponse?.taskType).toBe("general");
    expect((sr?.structuredResponse?.data as { response?: string }).response).toBe("The answer.");
    // The respond_* result must NOT also appear as a bare tool_result.
    expect(entries.some((e) => e.type === "tool_result")).toBe(false);
  });

  it("still rebuilds a non-response tool-result as a tool_result entry", () => {
    const callId = "call-read-1";
    MESSAGE_ROWS = [
      row(1, "user", "read the file"),
      row(2, "assistant", [
        { type: "tool-call", toolCallId: callId, toolName: "read_file", input: { file_path: "a.ts" } },
      ]),
      row(3, "tool", [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "read_file",
          output: { type: "json", value: { success: true, output: "file body" } },
        },
      ]),
    ];

    const entries = buildChatEntries("s1");
    expect(entries.some((e) => e.type === "structured_response")).toBe(false);
    expect(entries.some((e) => e.type === "tool_result")).toBe(true);
  });
});
