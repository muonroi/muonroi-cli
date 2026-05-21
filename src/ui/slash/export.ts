/**
 * src/ui/slash/export.ts
 *
 * /export slash command — exports the conversation to a .txt file.
 *
 * Two sources of truth:
 *   1. DB (`buildChatEntries`) — what was persisted as ModelMessages. Council
 *      streams content via StreamChunks that never land in `messages`, so this
 *      can come back empty even when the TUI is full of output.
 *   2. Live TUI scrollback (`ctx.getLiveEntries`) — what the user actually
 *      saw, including streamed council/tool/assistant chunks.
 *
 * The export writes BOTH (clearly labelled) when they diverge, so the user
 * can compare what was persisted vs what was shown. When they match (typical
 * resumed-session case), only one block is written.
 *
 * Self-registers on module import.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDatabase } from "../../storage/db.js";
import { buildChatEntries } from "../../storage/transcript.js";
import type { ChatEntry } from "../../types/index.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

interface InteractionRow {
  event_type: string;
  event_subtype: string | null;
  metadata_json: string | null;
  created_at: string;
}

function selectInteractionTimeline(sessionId: string): InteractionRow[] {
  try {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT event_type, event_subtype, metadata_json, created_at
         FROM interaction_logs
         WHERE session_id = ?
           AND event_type IN ('ui_interaction', 'routing', 'council', 'ee_injection')
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as InteractionRow[];
  } catch {
    return [];
  }
}

function renderInteractionTimeline(rows: readonly InteractionRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = ["── Interaction Timeline ──", ""];
  for (const r of rows) {
    const ts = formatTimestamp(r.created_at);
    const label = r.event_subtype ? `${r.event_type}.${r.event_subtype}` : r.event_type;
    let detail = "";
    if (r.metadata_json) {
      try {
        const meta = JSON.parse(r.metadata_json) as Record<string, unknown>;
        const parts: string[] = [];
        for (const [k, v] of Object.entries(meta)) {
          if (v === null || v === undefined) continue;
          // Error/diagnostic fields get a larger budget so root cause is
          // legible directly in the timeline. Other strings stay terse.
          const isLongField = k === "message" || k === "error" || k === "reason";
          const cap = isLongField ? 400 : 80;
          const vStr = typeof v === "string" ? (v.length > cap ? `${v.slice(0, cap - 3)}…` : v) : JSON.stringify(v);
          parts.push(`${k}=${vStr}`);
        }
        detail = parts.length > 0 ? ` ${parts.join(" ")}` : "";
      } catch {
        // Leave detail empty on bad JSON
      }
    }
    lines.push(`[${ts}] ${label}${detail}`);
  }
  lines.push("");
  return lines;
}

function formatTimestamp(ts: Date | string | undefined): string {
  if (!ts) return "";
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function renderEntries(entries: readonly ChatEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const ts = formatTimestamp(entry.timestamp);
    switch (entry.type) {
      case "user":
        lines.push(`[${ts}] You:`);
        lines.push(entry.content);
        lines.push("");
        break;
      case "assistant":
        lines.push(`[${ts}] Assistant:`);
        lines.push(entry.content);
        lines.push("");
        break;
      case "tool_result": {
        const toolName = entry.toolCall?.function?.name ?? "unknown";
        lines.push(`[${ts}] Tool [${toolName}]:`);
        lines.push(entry.content);
        lines.push("");
        break;
      }
      default:
        lines.push(`[${ts}] ${entry.type}:`);
        lines.push(entry.content);
        lines.push("");
        break;
    }
  }
  return lines;
}

/**
 * Quick structural signature so we can detect whether DB and live scrollback
 * are telling the same story without doing a full content diff. We compare
 * total entry count and the count of each kind — if those match, the two
 * sources almost certainly agree and we can emit a single block.
 */
function signature(entries: readonly ChatEntry[]): string {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return (
    `n=${entries.length} ` +
    Object.entries(counts)
      .sort()
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")
  );
}

function formatExport(
  dbEntries: readonly ChatEntry[],
  liveEntries: readonly ChatEntry[],
  timeline: readonly InteractionRow[],
): { text: string; mode: "db_only" | "live_only" | "merged" | "synced" } {
  const timelineBlock = renderInteractionTimeline(timeline);
  const dbSig = signature(dbEntries);
  const liveSig = signature(liveEntries);
  const header: string[] = [
    "=".repeat(72),
    "  muonroi-cli — Chat Export",
    `  Exported: ${formatTimestamp(new Date())}`,
    `  DB entries:    ${dbEntries.length}`,
    `  Live entries:  ${liveEntries.length}`,
    `  Timeline rows: ${timeline.length}`,
    "=".repeat(72),
    "",
  ];

  // Case 1: DB and live agree — single block, source=db (canonical).
  if (dbSig === liveSig && dbEntries.length > 0) {
    return {
      text: [
        ...header,
        "(DB and TUI scrollback match — single rendering)",
        "",
        ...timelineBlock,
        ...renderEntries(dbEntries),
        "=".repeat(72),
        "  End of export",
        "=".repeat(72),
      ].join("\n"),
      mode: "synced",
    };
  }

  // Case 2: DB empty, live has content — common for council-only sessions
  // where stream chunks bypass persistence. Use live as the source of truth.
  if (dbEntries.length === 0 && liveEntries.length > 0) {
    return {
      text: [
        ...header,
        `NOTE: Database has 0 entries but TUI scrollback has ${liveEntries.length}. This usually`,
        `means the conversation consisted of streamed chunks (council debate, tool traces)`,
        `that render to the TUI but are not persisted as ModelMessages. Showing TUI scrollback.`,
        "",
        ...timelineBlock,
        "── TUI Scrollback (in-memory) ──",
        "",
        ...renderEntries(liveEntries),
        "=".repeat(72),
        "  End of export",
        "=".repeat(72),
      ].join("\n"),
      mode: "live_only",
    };
  }

  // Case 3: Live empty, DB has content — slash invoked without TUI context
  // (e.g., a non-interactive caller). Just render DB.
  if (liveEntries.length === 0 && dbEntries.length > 0) {
    return {
      text: [
        ...header,
        "(Live scrollback unavailable — showing DB only)",
        "",
        ...timelineBlock,
        ...renderEntries(dbEntries),
        "=".repeat(72),
        "  End of export",
        "=".repeat(72),
      ].join("\n"),
      mode: "db_only",
    };
  }

  // Case 4: Both have content but they disagree — emit both, side by side,
  // so the caller can diff. This is the most useful mode for debugging why
  // a council session "looked full" but persisted little.
  return {
    text: [
      ...header,
      `WARNING: DB and TUI scrollback disagree.`,
      `  DB signature:    ${dbSig}`,
      `  Live signature:  ${liveSig}`,
      `Both renderings are included below for comparison.`,
      "",
      ...timelineBlock,
      "─".repeat(72),
      "── Section A: Persisted (DB)",
      "─".repeat(72),
      "",
      ...renderEntries(dbEntries),
      "─".repeat(72),
      "── Section B: Live TUI Scrollback",
      "─".repeat(72),
      "",
      ...renderEntries(liveEntries),
      "=".repeat(72),
      "  End of export",
      "=".repeat(72),
    ].join("\n"),
    mode: "merged",
  };
}

export const handleExportSlash: SlashHandler = async (_args, ctx) => {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return "No active session. Start a conversation first.";
  }

  const dbEntries = buildChatEntries(sessionId);
  const liveEntries = ctx.getLiveEntries?.() ?? [];
  const timeline = selectInteractionTimeline(sessionId);

  if (dbEntries.length === 0 && liveEntries.length === 0 && timeline.length === 0) {
    return "No messages in the current session to export (DB, TUI scrollback, and timeline are all empty).";
  }

  const { text, mode } = formatExport(dbEntries, liveEntries, timeline);

  const fileName = `chat-export-${sessionId}.txt`;
  const filePath = path.resolve(ctx.cwd, fileName);

  try {
    fs.writeFileSync(filePath, text, "utf-8");
    const modeNote =
      mode === "synced"
        ? "DB and TUI matched"
        : mode === "db_only"
          ? "DB only (no TUI scrollback)"
          : mode === "live_only"
            ? `TUI scrollback only (DB had 0 entries; ${liveEntries.length} live)`
            : `DB and TUI diverged — both included (db=${dbEntries.length}, live=${liveEntries.length})`;
    return `Exported to ${filePath} (${(text.length / 1024).toFixed(1)} KB) — ${modeNote}`;
  } catch (err) {
    return `Failed to write export file: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// Self-register on module import
registerSlash("export", handleExportSlash);
