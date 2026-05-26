/**
 * export-transcripts.test.ts
 *
 * Unit tests for exportTranscripts() — SQLite → JSONL transcript export.
 *
 * Strategy: redirect USERPROFILE (Windows) / HOME (POSIX) to a temp dir,
 * create a real SQLite DB at `~/.muonroi-cli/muonroi.db`, and call the
 * function.  Also creates `~/.experience/config.json` so the emit sidecar
 * (transcript-emit) does not gate-return null.
 */

import { Database } from "bun:sqlite";
// @ts-expect-error — bun:test is provided by the bun runtime; this file runs
// via `bun test`, not vitest (vitest cannot resolve bun:sqlite's `db.run` API).
// Excluded from vitest in vitest.config.ts.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome = "";
let origUserProfile: string | undefined;

function cleanDb() {
  if (tmpHome) {
    try {
      rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* ok */
    }
  }
}

function bootstrapDb(
  sessions: Array<{
    sessionId: string;
    updatedAt: string;
    cwdLast: string | null;
    messages: Array<{ seq: number; role: string; messageJson: string }>;
  }>,
) {
  const dbDir = join(tmpHome, ".muonroi-cli");
  const dbPath = join(dbDir, "muonroi.db");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, cwd_last TEXT DEFAULT NULL)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT DEFAULT NULL, status TEXT DEFAULT NULL)",
  );
  for (const s of sessions) {
    db.run("INSERT INTO sessions (id, updated_at, cwd_last) VALUES (?, ?, ?)", [s.sessionId, s.updatedAt, s.cwdLast]);
    for (const m of s.messages) {
      db.run("INSERT INTO messages (session_id, seq, role, message_json) VALUES (?, ?, ?, ?)", [
        s.sessionId,
        m.seq,
        m.role,
        m.messageJson,
      ]);
    }
  }
  db.close();
}

beforeEach(() => {
  tmpHome = join(tmpdir(), "muonroi-test-export-" + Date.now());
  const muonroiDir = join(tmpHome, ".muonroi-cli");
  const experienceDir = join(tmpHome, ".experience");
  mkdirSync(muonroiDir, { recursive: true });
  mkdirSync(experienceDir, { recursive: true });
  // Create a minimal config so transcript-emit's isEnabled() returns true.
  writeFileSync(join(experienceDir, "config.json"), JSON.stringify({}), "utf-8");
  origUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  cleanDb();
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
});

// ── tests ────────────────────────────────────────────────────────────

describe("exportTranscripts", () => {
  it("no DB file → throws", async () => {
    // No bootstrapDb call — DB doesn't exist.
    const mod = await import("../export-transcripts.js");
    await expect(mod.exportTranscripts()).rejects.toThrow();
  });

  it("dry-run with 0 sessions => empty result", async () => {
    await bootstrapDb([]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: true });
    expect(res.totalSessions).toBe(0);
    expect(res.written).toBe(0);
    expect(res.skippedEmpty).toBe(0);
    expect(res.skippedTooSmall).toBe(0);
  });

  it("dry-run emits sessions with >= 4 messages", async () => {
    await bootstrapDb([
      {
        sessionId: "sess-1",
        updatedAt: new Date().toISOString(),
        cwdLast: null,
        messages: [
          { seq: 1, role: "user", messageJson: JSON.stringify({ content: "hi" }) },
          { seq: 2, role: "assistant", messageJson: JSON.stringify({ content: "there" }) },
          { seq: 3, role: "user", messageJson: JSON.stringify({ content: "again" }) },
          { seq: 4, role: "assistant", messageJson: JSON.stringify({ content: "bye" }) },
        ],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: true });
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(1);
    expect(res.skippedEmpty).toBe(0);
    expect(res.skippedTooSmall).toBe(0);
  });

  it("wet-run writes JSONL files", async () => {
    await bootstrapDb([
      {
        sessionId: "sess-1",
        updatedAt: new Date().toISOString(),
        cwdLast: null,
        messages: [
          { seq: 1, role: "user", messageJson: JSON.stringify({ content: "hi" }) },
          { seq: 2, role: "assistant", messageJson: JSON.stringify({ content: "there" }) },
          { seq: 3, role: "user", messageJson: JSON.stringify({ content: "again" }) },
          { seq: 4, role: "assistant", messageJson: JSON.stringify({ content: "bye" }) },
        ],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: false });
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(1);
    expect(res.skippedEmpty).toBe(0);
    expect(res.skippedTooSmall).toBe(0);
  });

  it("skips sessions past maxAgeDays", async () => {
    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    await bootstrapDb([
      {
        sessionId: "sess-old",
        updatedAt: old,
        cwdLast: null,
        messages: [
          { seq: 1, role: "user", messageJson: JSON.stringify({ content: "old1" }) },
          { seq: 2, role: "assistant", messageJson: JSON.stringify({ content: "old resp1" }) },
          { seq: 3, role: "user", messageJson: JSON.stringify({ content: "old2" }) },
          { seq: 4, role: "assistant", messageJson: JSON.stringify({ content: "old resp2" }) },
        ],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: true, maxAgeDays: 7 });
    expect(res.totalSessions).toBe(0);
    expect(res.written).toBe(0);
  });

  it("skips sessions with too few messages", async () => {
    await bootstrapDb([
      {
        sessionId: "sess-small",
        updatedAt: new Date().toISOString(),
        cwdLast: null,
        messages: [{ seq: 1, role: "user", messageJson: JSON.stringify({ content: "only" }) }],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    // Default minMessages = 4
    const res = await mod.exportTranscripts({ dryRun: true });
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(0);
    expect(res.skippedTooSmall).toBe(1);
  });

  it("skippedEmpty when messages table returns nothing for a matched session", async () => {
    await bootstrapDb([
      {
        sessionId: "sess-empty",
        updatedAt: new Date().toISOString(),
        cwdLast: null,
        messages: [],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: true, maxAgeDays: 30 });
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(0);
    expect(res.skippedEmpty).toBe(1);
  });

  it("bad JSON in message_json row — throws by default", async () => {
    await bootstrapDb([
      {
        sessionId: "sess-bad",
        updatedAt: new Date().toISOString(),
        cwdLast: null,
        messages: [{ seq: 1, role: "user", messageJson: "NOT_VALID_JSON" }],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    // The function's inner callback in .map() wraps JSON.parse in try/catch
    // and returns null on failure. With null row messages.length<minMessages
    // so it falls through to skippedTooSmall. This is intentional per source.
    const res = await mod.exportTranscripts({ dryRun: true, minMessages: 1 });
    // minMessages=1, but the single row's parse fails → messages.length=0
    // -> skippedEmpty not skippedTooSmall
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(0);
    expect(res.skippedEmpty).toBe(1);
    expect(res.skippedTooSmall).toBe(0);
  });
});
