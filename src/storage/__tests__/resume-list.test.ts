/**
 * Real-SQLite verification of queryResumeList: a conversation tree
 * (root + rotation children + a sub-agent) collapses to ONE row, resuming
 * into the latest leaf, sub-agents excluded, title from the root.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { SQLiteDatabase, SQLiteStatement } from "../db.js";
import { applyMigrations } from "../migrations.js";
import { queryResumeList } from "../sessions.js";

const requireSync = createRequire(import.meta.url);

function makeRealDb(): { db: SQLiteDatabase; close: () => void } {
  // biome-ignore lint/suspicious/noExplicitAny: driver shape
  const BetterSqlite3 = requireSync("better-sqlite3") as any;
  const raw = new BetterSqlite3(":memory:");
  const db: SQLiteDatabase = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string): SQLiteStatement => {
      const stmt = raw.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...p),
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
      };
    },
    pragma: (q: string, o?: { simple?: boolean }) => raw.pragma(q, { simple: !!o?.simple }),
    transaction: <T>(fn: () => T) => raw.transaction(fn),
    close: () => raw.close(),
  };
  return { db, close: () => raw.close() };
}

function seed(db: SQLiteDatabase): void {
  applyMigrations(db); // build the full v10 schema from scratch
  db.prepare(
    "INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws1", "scope", "/tmp", "ws1", "2026-07-08T00:00:00Z");
  const insSession = (
    id: string,
    parent: string | null,
    kind: string,
    root: string,
    title: string | null,
    updated: string,
  ) =>
    db
      .prepare(
        "INSERT INTO sessions (id, workspace_id, parent_session_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at, kind, root_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "ws1",
        parent,
        title,
        "gpt",
        "agent",
        "/tmp",
        "/tmp",
        "active",
        "2026-07-08T00:00:00Z",
        updated,
        kind,
        root,
      );
  const insMsg = (sid: string) =>
    db
      .prepare("INSERT INTO messages (session_id, seq, role, message_json, created_at, status) VALUES (?,?,?,?,?,?)")
      .run(sid, 1, "user", "{}", "2026-07-08T00:00:00Z", "completed");

  // Tree A: root (older) → rotation leaf (newer) + a sub-agent (should be hidden)
  insSession("rootA", null, "conversation", "rootA", "Refactor auth", "2026-07-08T10:00:00Z");
  insSession("rotA", "rootA", "rotation", "rootA", null, "2026-07-08T12:00:00Z");
  insSession("subA", "rootA", "subagent", "rootA", null, "2026-07-08T11:00:00Z");
  insMsg("rootA");
  insMsg("rotA");
  insMsg("subA");

  // Tree B: standalone conversation, most recent activity overall.
  insSession("rootB", null, "conversation", "rootB", "Fix flaky test", "2026-07-08T13:00:00Z");
  insMsg("rootB");

  // Empty stub (no messages) — must be filtered out.
  insSession("stub", null, "conversation", "stub", "ghost", "2026-07-08T14:00:00Z");
}

describe("queryResumeList", () => {
  let handle: { db: SQLiteDatabase; close: () => void };
  afterEach(() => handle?.close());

  it("collapses a tree to one row and resumes the latest non-subagent leaf", () => {
    handle = makeRealDb();
    seed(handle.db);
    const rows = queryResumeList(handle.db, "ws1", 20);

    // Two trees (A, B); stub excluded (no messages).
    expect(rows.map((r) => r.id).sort()).toEqual(["rootA", "rootB"]);

    const a = rows.find((r) => r.id === "rootA")!;
    expect(a.title).toBe("Refactor auth"); // from the root
    expect(a.resumeId).toBe("rotA"); // latest leaf, NOT subA (subagent) nor rootA
    expect(a.updatedAt.toISOString()).toBe("2026-07-08T12:00:00.000Z"); // leaf's timestamp

    // Ordered by tree activity DESC → rootB (13:00) before rootA (12:00).
    expect(rows[0].id).toBe("rootB");
  });

  it("respects the limit", () => {
    handle = makeRealDb();
    seed(handle.db);
    expect(queryResumeList(handle.db, "ws1", 1)).toHaveLength(1);
  });
});
