/**
 * src/ui/slash/export.ts
 *
 * /export slash command — exports the entire conversation to a .txt file.
 * Reads all messages via buildChatEntries and writes a formatted transcript.
 *
 * Self-registers on module import.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildChatEntries } from "../../storage/transcript.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

function formatTimestamp(ts: Date | string | undefined): string {
  if (!ts) return "";
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function formatExport(entries: ReturnType<typeof buildChatEntries>): string {
  const lines: string[] = [
    "=" .repeat(72),
    "  muonroi-cli — Chat Export",
    "  Exported: " + formatTimestamp(new Date()),
    "=" .repeat(72),
    "",
  ];

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

  lines.push("=" .repeat(72));
  lines.push("  End of export");
  lines.push("=" .repeat(72));
  return lines.join("\n");
}

export const handleExportSlash: SlashHandler = async (_args, ctx) => {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return "No active session. Start a conversation first.";
  }

  const entries = buildChatEntries(sessionId);
  if (entries.length === 0) {
    return "No messages in the current session to export.";
  }

  const text = formatExport(entries);

  // Write to current working directory
  const fileName = `chat-export-${sessionId}.txt`;
  const filePath = path.resolve(ctx.cwd, fileName);

  try {
    fs.writeFileSync(filePath, text, "utf-8");
    return `Exported ${entries.length} messages to ${filePath} (${(text.length / 1024).toFixed(1)} KB)`;
  } catch (err) {
    return `Failed to write export file: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// Self-register on module import
registerSlash("export", handleExportSlash);
