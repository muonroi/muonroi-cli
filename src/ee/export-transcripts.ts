/**
 * One-shot SQLite → JSONL transcript exporter.
 *
 * Walks `~/.muonroi-cli/muonroi.db` `messages` table grouped by session_id,
 * normalizes each row's `message_json` (ai SDK ModelMessage shape) via the
 * same emitTranscriptToDisk encoder used at runtime, and writes one JSONL
 * file per session under `~/.experience/muonroi-cli-sessions/`.
 *
 * This is the backfill counterpart to runtime emit — exists so the user can
 * recover lessons from sessions that pre-date the transcript-emit feature.
 * Idempotent: re-running overwrites the same per-session JSONL.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emitTranscriptToDisk, getEmitRoot } from "./transcript-emit.js";

type Row = { session_id: string; seq: number; role: string; message_json: string };

async function openDb(dbPath: string): Promise<{
  all: (sql: string) => Row[];
  close: () => void;
}> {
  // Prefer better-sqlite3 (sync), fall back to bun:sqlite when running under Bun.
  // better-sqlite3 is an OPTIONAL runtime dep — its native build often fails on
  // Windows without VS Build Tools, so the module may be missing from
  // node_modules even when listed in package.json. The try/catch below handles
  // the runtime ENOENT; the ts-ignore keeps the build unblocked.
  try {
    // optional dep, may not be installed
    const mod = await import("better-sqlite3");
    const Better = (mod as { default?: unknown }).default ?? mod;
    const db = new (Better as new (p: string, o?: unknown) => unknown)(dbPath, { readonly: true }) as {
      prepare: (sql: string) => { all: () => Row[] };
      close: () => void;
    };
    return {
      all: (sql) => db.prepare(sql).all(),
      close: () => db.close(),
    };
  } catch {
    /* fall through */
  }
  try {
    const bun = await import("bun:sqlite").catch(() => null);
    if (!bun) throw new Error("no sqlite driver");
    const Database = (bun as { Database: new (p: string, o?: unknown) => unknown }).Database;
    const db = new Database(dbPath, { readonly: true }) as {
      query: (sql: string) => { all: () => Row[] };
      close: () => void;
    };
    return {
      all: (sql) => db.query(sql).all(),
      close: () => db.close(),
    };
  } catch (e) {
    throw new Error(
      `No SQLite driver available (tried better-sqlite3, bun:sqlite). Install better-sqlite3 or run under Bun. Cause: ${(e as Error).message}`,
    );
  }
}

export interface ExportOptions {
  maxAgeDays?: number; // default 30
  dryRun?: boolean;
  /** Minimum messages per session to bother emitting (default 4 — skip noise). */
  minMessages?: number;
  dbOverride?: any;
}

export interface ExportResult {
  totalSessions: number;
  written: number;
  skippedEmpty: number;
  skippedTooSmall: number;
  outputRoot: string;
}

export async function exportTranscripts(opts: ExportOptions = {}): Promise<ExportResult> {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const minMessages = opts.minMessages ?? 4;
  const dryRun = opts.dryRun ?? false;

  const db = opts.dbOverride ?? getDatabase();
  try {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    const cutoffIso = new Date(cutoff).toISOString();

    // Pull sessions touched in window. cwd_last is the cwd at session-end —
    // critical for EE scope detection so framework/lang resolve correctly.
    const sessions = db.all(
      `SELECT id, updated_at, cwd_last FROM sessions WHERE updated_at >= '${cutoffIso}' ORDER BY updated_at DESC`,
    ) as unknown as Array<{ id: string; updated_at: string; cwd_last: string | null }>;

    const out: ExportResult = {
      totalSessions: sessions.length,
      written: 0,
      skippedEmpty: 0,
      skippedTooSmall: 0,
      outputRoot: getEmitRoot(),
    };

    for (const s of sessions) {
      const rows = db.all(
        `SELECT session_id, seq, role, message_json FROM messages WHERE session_id = '${s.id.replace(/'/g, "''")}' ORDER BY seq ASC`,
      ) as unknown as Row[];

      if (rows.length === 0) {
        out.skippedEmpty++;
        continue;
      }
      if (rows.length < minMessages) {
        out.skippedTooSmall++;
        continue;
      }

      const messages = rows
        .map((r) => {
          try {
            return JSON.parse(r.message_json) as { role: string; content: unknown };
          } catch {
            return null;
          }
        })
        .filter((m): m is { role: string; content: unknown } => m !== null);

      if (messages.length === 0) {
        out.skippedEmpty++;
        continue;
      }

      if (dryRun) {
        console.log(`[dry-run] would emit ${s.id} (${messages.length} msgs)`);
        out.written++;
        continue;
      }

      // Re-use runtime emitter so format matches stop-extractor parser exactly.
      // Cast to ModelMessage[]: the on-disk shape and ModelMessage are wire-compatible
      // — emitTranscriptToDisk only inspects role + content blocks.
      const target = emitTranscriptToDisk(
        messages as unknown as Parameters<typeof emitTranscriptToDisk>[0],
        s.id,
        "cli-exit",
        s.cwd_last ?? null,
      );
      if (target) out.written++;
    }

    return out;
  } finally {
    db.close();
  }
}
