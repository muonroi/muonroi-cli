import type { ModelMessage } from "ai";
import { getCompactionSummaryText } from "../orchestrator/compaction";
import type { ChatEntry, ToolCall, ToolResult } from "../types/index";
import { getDatabase, withTransaction } from "./db";
import { extractToolResultFromOutput, getOutputKind, isOutputSuccess } from "./tool-results";
import { buildEffectiveTranscript, type LoadedTranscriptState, type PersistedCompaction } from "./transcript-view";

interface MessageRow {
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

interface StoredToolCallRow {
  id: number;
  tool_call_id: string;
  tool_name: string;
  args_json: string;
}

interface StoredToolResultRow {
  tool_call_id: string;
  output_json: string;
}

interface CompactionRow {
  session_id: string;
  first_kept_seq: number;
  summary: string;
  tokens_before: number;
  created_at: string;
}

interface EffectiveMessageRecord {
  message: ModelMessage;
  seq: number | null;
  timestamp: Date;
}

/**
 * On resume, scrub raw base64 image payloads from historical tool results.
 * Older sessions may have multi-MB Playwright screenshots inlined in tool
 * outputs (the vision bridge used to leave them in place when the proxy
 * failed). Loading them back into context causes provider calls to overflow
 * the model's max context. We replace each oversized base64 blob with a
 * stable placeholder so the resumed conversation stays under the limit.
 */
function sanitizeBase64InMessageJson(json: string): string {
  if (json.length < 50_000) return json;
  // Strip data URIs first (`data:image/png;base64,...`).
  let scrubbed = json.replace(
    /data:image\/[a-z+]+;base64,[A-Za-z0-9+/]{1000,}={0,2}/g,
    "[image data removed on resume]",
  );
  // Then strip any remaining oversized base64 string literals — likely raw
  // image payloads in MCP tool result fields (e.g. {"data":"iVBORw0KGgo..."}).
  scrubbed = scrubbed.replace(/"[A-Za-z0-9+/]{2000,}={0,2}"/g, '"[image data removed on resume]"');
  return scrubbed;
}

/**
 * System messages with these prefixes are internal context markers used by
 * the council layer for follow-up rehydration. They MUST NOT render in the
 * TUI or chat export — they leak structured JSON / raw transcripts to the
 * user and bloat exports. Council still relies on them being persisted; only
 * the rendered view filters them out.
 */
const INTERNAL_COUNCIL_MARKER_PREFIXES = [
  "[Debate Transcript]",
  "[Council Round ",
  "[Council Outcome]",
  "[Council Memory]",
  "[Council Tool Trace]",
  "[NEEDS HUMAN REVIEW]",
] as const;

function isInternalCouncilMarker(content: string): boolean {
  const head = content.trimStart();
  return INTERNAL_COUNCIL_MARKER_PREFIXES.some((p) => head.startsWith(p));
}

function loadMessageRows(sessionId: string): MessageRow[] {
  const rows = getDatabase()
    .prepare(`
    SELECT session_id, seq, role, message_json, created_at
    FROM messages
    WHERE session_id = ?
    ORDER BY seq ASC
  `)
    .all(sessionId) as MessageRow[];
  for (const row of rows) {
    row.message_json = sanitizeBase64InMessageJson(row.message_json);
  }
  return rows;
}

function toPersistedCompaction(row: CompactionRow | undefined): PersistedCompaction | null {
  if (!row) return null;
  return {
    firstKeptSeq: row.first_kept_seq,
    summary: row.summary,
    tokensBefore: row.tokens_before,
    createdAt: new Date(row.created_at),
  };
}

export function loadLatestCompaction(sessionId: string): PersistedCompaction | null {
  const row = getDatabase()
    .prepare(`
    SELECT session_id, first_kept_seq, summary, tokens_before, created_at
    FROM compactions
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 1
  `)
    .get(sessionId) as CompactionRow | undefined;

  return toPersistedCompaction(row);
}

function buildEffectiveMessageRecords(sessionId: string): EffectiveMessageRecord[] {
  const rows = loadMessageRows(sessionId);
  const messages = rows.map((row) => JSON.parse(row.message_json) as ModelMessage);
  const seqs = rows.map((row) => row.seq);
  const timestamps = rows.map((row) => new Date(row.created_at));
  const transcript = buildEffectiveTranscript(messages, seqs, timestamps, loadLatestCompaction(sessionId));

  return transcript.messages.map((message, index) => ({
    message,
    seq: transcript.seqs[index],
    timestamp: transcript.timestamps[index],
  }));
}

export function loadRawTranscript(sessionId: string): ModelMessage[] {
  return loadMessageRows(sessionId).map((row) => JSON.parse(row.message_json) as ModelMessage);
}

export function loadTranscriptState(sessionId: string): LoadedTranscriptState {
  const rows = loadMessageRows(sessionId);
  return buildEffectiveTranscript(
    rows.map((row) => JSON.parse(row.message_json) as ModelMessage),
    rows.map((row) => row.seq),
    rows.map((row) => new Date(row.created_at)),
    loadLatestCompaction(sessionId),
  );
}

export function loadTranscript(sessionId: string): ModelMessage[] {
  return loadTranscriptState(sessionId).messages;
}

export function getNextMessageSequence(sessionId: string): number {
  return getNextSequence(getDatabase(), sessionId);
}

export function appendMessages(sessionId: string, messages: ModelMessage[]): number[] {
  if (messages.length === 0) return [];

  const insertedSeqs: number[] = [];
  withTransaction((db) => {
    const nextSeq = getNextSequence(db, sessionId);
    // Phase A5 — `INSERT OR REPLACE` so a pre-existing write-ahead row
    // (status='pending', placeholder message_json) is finalized atomically
    // with `status='completed'` and the full message_json. Pre-A5 callers
    // hit this path identically: there is no pending row so the IGNORE
    // branch is unused and the INSERT wins.
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, seq, role, message_json, created_at, status)
      VALUES (?, ?, ?, ?, ?, 'completed')
      ON CONFLICT(session_id, seq) DO UPDATE SET
        role = excluded.role,
        message_json = excluded.message_json,
        status = 'completed'
    `);
    const insertToolCall = db.prepare(`
      INSERT OR IGNORE INTO tool_calls (
        session_id, message_seq, tool_call_id, tool_name, args_json, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateToolCall = db.prepare(`
      UPDATE tool_calls
      SET tool_name = ?, args_json = ?, status = ?, completed_at = ?
      WHERE session_id = ? AND tool_call_id = ?
    `);
    const selectToolCall = db.prepare(`
      SELECT id, tool_call_id, tool_name, args_json
      FROM tool_calls
      WHERE session_id = ? AND tool_call_id = ?
    `);
    const insertToolResult = db.prepare(`
      INSERT INTO tool_results (tool_call_row_id, output_kind, output_json, success, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateSession = db.prepare(`
      UPDATE sessions
      SET updated_at = ?
      WHERE id = ?
    `);

    messages.forEach((message, index) => {
      const seq = nextSeq + index;
      const createdAt = new Date().toISOString();
      insertedSeqs.push(seq);
      insertMessage.run(sessionId, seq, message.role, JSON.stringify(message), createdAt);

      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== "tool-call") continue;
          insertToolCall.run(
            sessionId,
            seq,
            part.toolCallId,
            part.toolName,
            JSON.stringify(part.input ?? {}),
            "completed",
            createdAt,
            createdAt,
          );
          updateToolCall.run(
            part.toolName,
            JSON.stringify(part.input ?? {}),
            "completed",
            createdAt,
            sessionId,
            part.toolCallId,
          );
        }
      }

      if (message.role === "tool" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          let toolCall = selectToolCall.get(sessionId, part.toolCallId) as StoredToolCallRow | undefined;
          if (!toolCall) {
            insertToolCall.run(sessionId, seq, part.toolCallId, part.toolName, "{}", "completed", createdAt, createdAt);
            toolCall = selectToolCall.get(sessionId, part.toolCallId) as StoredToolCallRow | undefined;
          }
          if (!toolCall) continue;

          const extracted = extractToolResultFromOutput(part.output);
          insertToolResult.run(
            toolCall.id,
            getOutputKind(part.output),
            JSON.stringify(extracted ?? part.output),
            extracted ? Number(extracted.success) : Number(isOutputSuccess(part.output)),
            createdAt,
          );
        }
      }
    });

    updateSession.run(new Date().toISOString(), sessionId);
  });

  return insertedSeqs;
}

export function appendSystemMessage(sessionId: string, content: string): number | null {
  return appendMessages(sessionId, [{ role: "system", content }])[0] ?? null;
}

/**
 * Phase A4 — Write-ahead persistence for tool_calls.
 *
 * The orchestrator's streamText loop sees a `tool-call` part *before* the
 * assistant message is finalized. If the stream throws between this point
 * and `appendCompletedTurn(...)`, the row that the post-stream
 * `appendMessages(...)` path would have written never materializes — and
 * `usage forensics <prefix>` has no record of what input the model passed.
 *
 * This helper writes a `pending` row immediately. The downstream
 * `appendMessages(...)` path uses `INSERT OR IGNORE` + `UPDATE` keyed on
 * `(session_id, tool_call_id)`, so the same row is finalized to `completed`
 * once the turn settles. On mid-stream failure the row stays as `pending`,
 * giving forensics + recovery a recoverable trail.
 *
 * `messageSeq` is the predicted assistant seq (typically
 * `getNextMessageSequence(sessionId) + 1` if the user message is also being
 * inserted as part of the same turn). It is corrected by the post-stream
 * UPDATE if the prediction was off.
 */
export function persistToolCallWriteAhead(
  sessionId: string,
  messageSeq: number,
  toolCallId: string,
  toolName: string,
  argsJson: string,
): void {
  const now = new Date().toISOString();
  try {
    getDatabase()
      .prepare(`
        INSERT OR IGNORE INTO tool_calls (
          session_id, message_seq, tool_call_id, tool_name, args_json, status, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)
      `)
      .run(sessionId, messageSeq, toolCallId, toolName, argsJson, now);
  } catch {
    // Fail-open: write-ahead is best-effort. The post-stream UPDATE path
    // will still finalize the row from `appendMessages(...)`.
  }
}

/**
 * Phase A4 — Mark a write-ahead tool_call row as `errored` when the AI SDK
 * surfaces a `tool-error` stream part (tool execution threw/aborted before
 * a tool-result was emitted). The post-stream `appendMessages(...)` path
 * does NOT see tool-error parts in the assistant message content, so without
 * this update the row would stay `pending` forever.
 */
/**
 * Phase A5 — Write-ahead persistence for `messages`.
 *
 * Mirrors {@link persistToolCallWriteAhead} for the assistant/user row that
 * `streamText` will accumulate. The orchestrator's `onStepFinish` callback
 * fires `recordUsage` while the stream is in-flight; without a pre-existing
 * row, `lastPersistedSeq(this.messageSeqs)` returns the previous turn's seq
 * (or NULL for the first turn → exactly the anomaly forensics surfaces).
 *
 * Strategy:
 *   1. Caller computes the next seq via `getNextMessageSequence(sessionId)`.
 *   2. Caller invokes this helper just before pushing the message into
 *      `this.messages` and BEFORE calling streamText.
 *   3. Caller stores the seq into `this.messageSeqs` so subsequent
 *      `recordUsage` calls resolve `message_seq` to a non-NULL value.
 *   4. After the turn settles, `appendMessages(...)` upserts the same row
 *      via `ON CONFLICT(session_id, seq) DO UPDATE` — finalizing
 *      `status='completed'` and overwriting the placeholder `message_json`.
 *
 * `message_json` is initially a placeholder so the column's NOT NULL
 * constraint is satisfied; the post-stream UPDATE overwrites it.
 *
 * Fail-open: callers are inside the orchestrator hot path, so a SQL
 * exception here MUST NOT propagate. The downstream `appendMessages(...)`
 * still writes the row (just without a write-ahead trail in forensics).
 */
export function persistMessageWriteAhead(sessionId: string, seq: number, role: string, messageJson: string): void {
  const now = new Date().toISOString();
  try {
    getDatabase()
      .prepare(`
        INSERT OR IGNORE INTO messages (
          session_id, seq, role, message_json, created_at, status
        ) VALUES (?, ?, ?, ?, ?, 'pending')
      `)
      .run(sessionId, seq, role, messageJson, now);
  } catch {
    /* fail-open */
  }
}

/**
 * Phase A5 — Finalize a write-ahead message row from `status='pending'`
 * to `status='completed'`. Called by `appendCompletedTurn(...)` after the
 * stream settles successfully. The row's `message_json` already contains
 * the final payload (written by `persistMessageWriteAhead(...)`), so this
 * is a cheap status flip.
 */
export function markMessageCompleted(sessionId: string, seq: number): void {
  try {
    getDatabase()
      .prepare(`
        UPDATE messages
        SET status = 'completed'
        WHERE session_id = ? AND seq = ? AND status = 'pending'
      `)
      .run(sessionId, seq);
  } catch {
    /* fail-open */
  }
}

/**
 * Phase A5 — Mark a write-ahead message row as `errored` when the stream
 * throws between `persistMessageWriteAhead(...)` and the post-stream
 * `appendMessages(...)` finalize step.
 *
 * Without this, a crashed turn would leave the row stuck at `pending`
 * forever, indistinguishable from "stream still in-flight" in forensics.
 */
export function markMessageErrored(sessionId: string, seq: number): void {
  try {
    getDatabase()
      .prepare(`
        UPDATE messages
        SET status = 'errored'
        WHERE session_id = ? AND seq = ? AND status = 'pending'
      `)
      .run(sessionId, seq);
  } catch {
    /* fail-open */
  }
}

/**
 * Mark write-ahead rows orphaned by an earlier process kill (Ctrl+C, OOM,
 * `taskkill /F`) as `aborted` instead of leaving them `pending` forever.
 *
 * Triggered by SessionStore.openSession() so a fresh launch cleans up after
 * the previous run that died mid-turn. Only rows older than `staleAfterMs`
 * are touched — leaving a 5-minute safety margin so a concurrently-running
 * muonroi-cli process never has its live in-flight rows clobbered.
 *
 * Two row classes:
 *  - `tool_calls.status = 'pending'`  and `started_at` older than threshold
 *    → set status='aborted', completed_at=now (so forensics can distinguish
 *    "tool exec threw" (errored) from "process died before result" (aborted))
 *  - `messages.status = 'pending'`    and `created_at` older than threshold
 *    → set status='aborted'
 *
 * Returns the row counts changed (mostly for tests + ops visibility).
 */
export function sweepStalePendingRows(staleAfterMs = 5 * 60 * 1000): { toolCalls: number; messages: number } {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const now = new Date().toISOString();
  try {
    const db = getDatabase();
    const toolCalls = db
      .prepare(`
        UPDATE tool_calls
        SET status = 'aborted', completed_at = ?
        WHERE status = 'pending' AND started_at < ?
      `)
      .run(now, cutoff) as { changes: number };
    const messages = db
      .prepare(`
        UPDATE messages
        SET status = 'aborted'
        WHERE status = 'pending' AND created_at < ?
      `)
      .run(cutoff) as { changes: number };
    return { toolCalls: toolCalls.changes, messages: messages.changes };
  } catch (err) {
    console.error(`[transcript] sweepStalePendingRows failed: ${(err as Error)?.message}`);
    return { toolCalls: 0, messages: 0 };
  }
}

export function markToolCallErrored(sessionId: string, toolCallId: string, errorMessage: string): void {
  const now = new Date().toISOString();
  try {
    getDatabase()
      .prepare(`
        UPDATE tool_calls
        SET status = 'errored', completed_at = ?, args_json = COALESCE(args_json, ?)
        WHERE session_id = ? AND tool_call_id = ?
      `)
      .run(now, JSON.stringify({ error: errorMessage.slice(0, 500) }), sessionId, toolCallId);
  } catch {
    /* fail-open */
  }
}

export function appendCompaction(sessionId: string, firstKeptSeq: number, summary: string, tokensBefore: number): void {
  withTransaction((db) => {
    db.prepare(`
      INSERT INTO compactions (session_id, first_kept_seq, summary, tokens_before, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, firstKeptSeq, summary, tokensBefore, new Date().toISOString());

    db.prepare(`
      UPDATE sessions
      SET updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), sessionId);
  });
}

export function buildChatEntries(sessionId: string): ChatEntry[] {
  const toolResults = loadStoredToolResults(sessionId);
  const callMap = new Map<string, ToolCall>();
  const entries: ChatEntry[] = [];

  for (const row of buildEffectiveMessageRecords(sessionId)) {
    const { message, timestamp } = row;

    if (message.role === "user") {
      const content = renderUserContent(message.content);
      if (content) {
        entries.push({ type: "user", content, timestamp });
      }
      continue;
    }

    if (message.role === "system") {
      const content =
        getCompactionSummaryText(message) ?? (typeof message.content === "string" ? message.content.trim() : "");
      if (content && !isInternalCouncilMarker(content)) {
        entries.push({ type: "assistant", content, timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = renderAssistantContent(message.content, callMap);
      if (text) {
        entries.push({ type: "assistant", content: text, timestamp });
      }
      continue;
    }

    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const toolCall = callMap.get(part.toolCallId) ?? toFallbackToolCall(part.toolCallId, part.toolName);
        const toolResult = toolResults.get(part.toolCallId) ??
          extractToolResultFromOutput(part.output) ?? {
            success: isOutputSuccess(part.output),
            output: JSON.stringify(part.output),
          };
        entries.push({
          type: "tool_result",
          content: toolResult.success ? toolResult.output || "Success" : toolResult.error || "Error",
          timestamp,
          toolCall,
          toolResult,
        });
      }
    }
  }

  return entries;
}

function getNextSequence(db: ReturnType<typeof getDatabase>, sessionId: string): number {
  const row = db
    .prepare(`
    SELECT COALESCE(MAX(seq), 0) AS max_seq
    FROM messages
    WHERE session_id = ?
  `)
    .get(sessionId) as { max_seq: number } | undefined;

  return (row?.max_seq ?? 0) + 1;
}

function renderUserContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "[Image]";
      if (part.type === "file") return part.filename ? `[File: ${part.filename}]` : "[File]";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderAssistantContent(content: ModelMessage["content"], callMap: Map<string, ToolCall>): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }

    if (part.type === "tool-call") {
      callMap.set(part.toolCallId, {
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }

  return textParts.join("").trim();
}

function loadStoredToolResults(sessionId: string): Map<string, ToolResult> {
  const rows = getDatabase()
    .prepare(`
    SELECT tc.tool_call_id, tr.output_json
    FROM tool_results tr
    JOIN tool_calls tc ON tc.id = tr.tool_call_row_id
    WHERE tc.session_id = ?
    ORDER BY tr.id ASC
  `)
    .all(sessionId) as StoredToolResultRow[];

  return new Map(rows.map((row) => [row.tool_call_id, JSON.parse(row.output_json) as ToolResult]));
}

function toFallbackToolCall(toolCallId: string, toolName: string): ToolCall {
  return {
    id: toolCallId,
    type: "function",
    function: {
      name: toolName,
      arguments: "{}",
    },
  };
}
