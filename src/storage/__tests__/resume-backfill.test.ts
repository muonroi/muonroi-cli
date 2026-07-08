/**
 * Real-SQLite verification of the v10 backfill (kind + root_session_id).
 * Uses better-sqlite3 directly (Node) — bypasses the global bun:sqlite mock
 * and getDatabase()'s driver selection, so we exercise the actual UPDATE/SELECT
 * logic the fake DB in migrations.test.ts cannot run.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { SQLiteDatabase, SQLiteStatement } from "../db.js";
import { applyMigrations } from "../migrations.js";

const requireSync = createRequire(import.meta.url);

// Minimal SQLiteDatabase adapter over a real in-memory better-sqlite3 DB.
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

// Build a v9-shaped schema + seed rows, then run applyMigrations (→ v10).
function seedV9(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, scope_key TEXT, canonical_path TEXT, git_root TEXT, display_name TEXT, last_seen_at TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      title TEXT, model TEXT NOT NULL, mode TEXT NOT NULL,
      cwd_at_start TEXT NOT NULL, cwd_last TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const ins = (id: string, parent: string | null) =>
    db
      .prepare(
        "INSERT INTO sessions (id, workspace_id, parent_session_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, "ws1", parent, id === "root1" ? "Root One" : null, "m", "agent", "/tmp", "/tmp", "active", "t", "t");
  ins("root1", null); // conversation root
  ins("rot1", "root1"); // rotation child
  ins("rot2", "rot1"); // rotation grandchild
  db.pragma("user_version = 9");
}

describe("v10 backfill", () => {
  let handle: { db: SQLiteDatabase; close: () => void };
  afterEach(() => handle?.close());

  it("sets root_session_id down a rotation chain and marks children rotation", () => {
    handle = makeRealDb();
    seedV9(handle.db);
    applyMigrations(handle.db);

    const rows = handle.db.prepare("SELECT id, kind, root_session_id FROM sessions ORDER BY id").all() as Array<{
      id: string;
      kind: string;
      root_session_id: string;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId.root1.kind).toBe("conversation");
    expect(byId.root1.root_session_id).toBe("root1");
    expect(byId.rot1.kind).toBe("rotation");
    expect(byId.rot1.root_session_id).toBe("root1");
    expect(byId.rot2.kind).toBe("rotation");
    expect(byId.rot2.root_session_id).toBe("root1");
  });

  it("gives an orphaned-parent row its own root", () => {
    handle = makeRealDb();
    seedV9(handle.db);
    // Simulate a parent that was SET NULL by the FK (orphan) via a dangling id.
    handle.db
      .prepare(
        "INSERT INTO sessions (id, workspace_id, parent_session_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("orphan1", "ws1", null, null, "m", "agent", "/tmp", "/tmp", "active", "t", "t");
    applyMigrations(handle.db);

    const row = handle.db.prepare("SELECT root_session_id FROM sessions WHERE id = ?").get("orphan1") as {
      root_session_id: string;
    };
    expect(row.root_session_id).toBe("orphan1");
  });
});
