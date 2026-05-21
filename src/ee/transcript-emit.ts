/**
 * Transcript emit — resilient sidecar to extractSession.
 *
 * Writes the in-memory ModelMessage[] of the current session to a JSONL file
 * under `~/.experience/muonroi-cli-sessions/{sessionId}.jsonl` using the SAME
 * shape that Claude Code's `~/.claude/projects/*.jsonl` uses (one entry per
 * message with `{ message: { role, content: [...blocks] } }`).
 *
 * Why this exists alongside extract-session.ts:
 * - extractSession() POSTs directly to EE /api/extract — fast path, depends on
 *   the engine being up at the moment of session-end / clear / compact.
 * - This module is the SLOW PATH: dump-to-disk so the EE stop-extractor
 *   backfill loop can pick the file up later, even if:
 *     1. EE was offline at session-end (network blip, engine restart),
 *     2. user closed the terminal with X (Node exits before HTTP fires),
 *     3. user ran /compact (we want lessons from the compacted history too).
 *
 * The output mirrors Claude's JSONL shape so the existing
 * stop-extractor `buildClaudeSessionData()` parser handles it unmodified —
 * we just add a new scan path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";

const EMIT_ROOT = path.join(os.homedir(), ".experience", "muonroi-cli-sessions");
const MAX_BLOCK_CHARS = 8000;

type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; content: string };

type ClaudeJsonlEntry = {
  message: { role: "user" | "assistant" | "tool" | "system"; content: ClaudeBlock[] };
  ts: string;
  source: "muonroi-cli";
  reason: "cli-exit" | "cli-clear" | "cli-compact" | "cli-signal";
};

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* fail-open */
  }
}

function clip(s: string): string {
  if (s.length <= MAX_BLOCK_CHARS) return s;
  return `${s.slice(0, MAX_BLOCK_CHARS)}... [truncated ${s.length - MAX_BLOCK_CHARS} chars]`;
}

function normalizeContent(content: unknown): ClaudeBlock[] {
  if (typeof content === "string") return [{ type: "text", text: clip(content) }];
  if (!Array.isArray(content)) return [];
  const out: ClaudeBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as {
      type?: string;
      text?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      result?: unknown;
    };
    if (p.type === "text" && typeof p.text === "string") {
      out.push({ type: "text", text: clip(p.text) });
      continue;
    }
    if ((p.type === "tool-call" || p.type === "tool_call") && p.toolName) {
      out.push({ type: "tool_use", name: p.toolName, input: p.input ?? {} });
      continue;
    }
    if (p.type === "tool-result" || p.type === "tool_result") {
      const body = p.output ?? p.result ?? "";
      out.push({ type: "tool_result", content: clip(typeof body === "string" ? body : JSON.stringify(body)) });
    }
  }
  return out;
}

function toJsonlEntry(msg: ModelMessage, reason: ClaudeJsonlEntry["reason"]): ClaudeJsonlEntry | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") return null;
  const content = normalizeContent((msg as { content: unknown }).content);
  if (content.length === 0) return null;
  return {
    message: { role, content },
    ts: new Date().toISOString(),
    source: "muonroi-cli",
    reason,
  };
}

/**
 * Emit the session transcript to disk for later EE backfill.
 *
 * Returns the path written to, or null if no eligible content / sessionId.
 * All errors swallowed — this is best-effort, never blocks shutdown.
 */
export function emitTranscriptToDisk(
  messages: ModelMessage[],
  sessionId: string | null | undefined,
  reason: ClaudeJsonlEntry["reason"],
): string | null {
  try {
    if (!sessionId) return null;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const entries = messages.map((m) => toJsonlEntry(m, reason)).filter((e): e is ClaudeJsonlEntry => e !== null);
    if (entries.length === 0) return null;

    ensureDir(EMIT_ROOT);
    // One file per (session × reason) so /clear and /compact mid-session
    // don't overwrite the pre-clear snapshot — the backfill loop walks them all.
    const reasonSuffix = reason === "cli-exit" ? "" : `.${reason}`;
    const filename = `${sessionId}${reasonSuffix}.jsonl`;
    const target = path.join(EMIT_ROOT, filename);

    const body = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    fs.writeFileSync(target, body, "utf8");
    return target;
  } catch {
    return null;
  }
}

export function getEmitRoot(): string {
  return EMIT_ROOT;
}
