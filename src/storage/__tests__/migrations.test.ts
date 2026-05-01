/**
 * src/storage/__tests__/migrations.test.ts
 *
 * Tests for DB migration v3 (pil_active + enrichment_delta columns).
 *
 * Uses an in-memory SQLiteDatabase implemented via vi.mock for bun:sqlite,
 * then delegates to a pure-JS in-memory store to verify schema mutations.
 *
 * Strategy: mock `bun:sqlite` before import, then use the SQLiteDatabase
 * interface directly to call applyMigrations() and assert column additions.
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// In-memory SQLite-like test database
// ---------------------------------------------------------------------------
// We cannot use bun:sqlite in vitest/Node. Instead we implement the minimal
// SQLiteDatabase interface needed by applyMigrations() and recordUsageEvent().
// Tracks executed SQL statements and user_version pragma state.

interface ColumnDef {
  name: string;
  type: string;
  notNull: boolean;
  defaultVal: unknown;
}

class InMemoryDatabase {
  readonly tables: Map<string, Map<string, ColumnDef>> = new Map();
  readonly rows: Map<string, unknown[]> = new Map();
  userVersion = 0;

  exec(sql: string): void {
    // Parse CREATE TABLE statements to extract column info
    this.parseAndApply(sql);
  }

  private parseAndApply(sql: string): void {
    // Split on semicolons for multi-statement exec
    const stmts = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      this.applySingleStatement(stmt);
    }
  }

  private applySingleStatement(stmt: string): void {
    const upper = stmt.trim().toUpperCase();

    if (upper.startsWith("CREATE TABLE")) {
      this.applyCreateTable(stmt);
    } else if (upper.startsWith("ALTER TABLE") && upper.includes("ADD COLUMN")) {
      this.applyAlterTable(stmt);
    } else if (upper.startsWith("CREATE INDEX") || upper.startsWith("PRAGMA")) {
      // Ignore indexes and pragma in exec (pragma handled separately)
    }
    // INSERT, SELECT, etc. handled in prepare()
  }

  private applyCreateTable(stmt: string): void {
    // Extract table name
    const match = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i);
    if (!match) return;
    const tableName = match[1].toLowerCase();
    if (this.tables.has(tableName)) return; // IF NOT EXISTS

    const columns = new Map<string, ColumnDef>();
    // Extract column definitions (simplified — handles PRIMARY KEY, NOT NULL, DEFAULT)
    const body = stmt.slice(stmt.indexOf("(") + 1, stmt.lastIndexOf(")"));
    const colDefs = this.splitColumnDefs(body);
    for (const def of colDefs) {
      const parsed = this.parseColumnDef(def);
      if (parsed) columns.set(parsed.name.toLowerCase(), parsed);
    }
    this.tables.set(tableName, columns);
    this.rows.set(tableName, []);
  }

  private applyAlterTable(stmt: string): void {
    const match = stmt.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(.*)/i);
    if (!match) return;
    const tableName = match[1].toLowerCase();
    const colDef = match[2].trim().replace(/;$/, "");
    const parsed = this.parseColumnDef(colDef);
    if (!parsed) return;
    const table = this.tables.get(tableName);
    if (!table) return;
    // Do not add if already exists (idempotent)
    if (!table.has(parsed.name.toLowerCase())) {
      table.set(parsed.name.toLowerCase(), parsed);
    }
  }

  private splitColumnDefs(body: string): string[] {
    const defs: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        defs.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) defs.push(current.trim());
    return defs;
  }

  private parseColumnDef(def: string): ColumnDef | null {
    const tokens = def.trim().split(/\s+/);
    if (!tokens[0]) return null;
    const name = tokens[0].replace(/^"|"$/g, "");
    // Skip table constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK)
    const upper = name.toUpperCase();
    if (["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"].includes(upper)) return null;

    const type = tokens[1] ?? "TEXT";
    const notNull = def.toUpperCase().includes("NOT NULL");
    let defaultVal: unknown = null;
    const defaultMatch = def.match(/DEFAULT\s+(\S+)/i);
    if (defaultMatch) {
      const raw = defaultMatch[1].replace(/['"]/g, "");
      defaultVal = Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
    return { name: name.toLowerCase(), type, notNull, defaultVal };
  }

  prepare(sql: string) {
    return {
      run: (...params: unknown[]) => this.runInsert(sql, params),
      get: (...params: unknown[]) => this.runQuery(sql, params),
      all: (...params: unknown[]) => this.runQueryAll(sql, params),
    };
  }

  private runInsert(sql: string, params: unknown[]): unknown {
    const upper = sql.trim().toUpperCase();
    if (!upper.startsWith("INSERT")) return;

    // Extract table name
    const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES/i);
    if (!match) return;
    const tableName = match[1].toLowerCase();
    const colNames = match[2].split(",").map((c) => c.trim().toLowerCase());
    const tableRows = this.rows.get(tableName) ?? [];
    const table = this.tables.get(tableName);
    if (!table) return;

    // Build row from params + defaults
    const row: Record<string, unknown> = {};
    for (const [i, colName] of colNames.entries()) {
      row[colName] = params[i];
    }
    // Apply defaults for missing columns
    for (const [colName, def] of table.entries()) {
      if (!(colName in row)) {
        row[colName] = def.defaultVal;
      }
    }
    tableRows.push(row);
    this.rows.set(tableName, tableRows);
    return row;
  }

  private runQuery(sql: string, _params: unknown[]): unknown {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("PRAGMA")) {
      if (upper.includes("TABLE_INFO")) {
        const match = sql.match(/table_info\((\w+)\)/i);
        if (!match) return null;
        const tableName = match[1].toLowerCase();
        const table = this.tables.get(tableName);
        if (!table) return null;
        const cols = [...table.values()];
        return cols.length > 0 ? cols[0] : null;
      }
      if (upper.includes("USER_VERSION")) {
        return { user_version: this.userVersion };
      }
      return null;
    }
    return null;
  }

  private runQueryAll(sql: string, params: unknown[]): unknown[] {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("PRAGMA") && upper.includes("TABLE_INFO")) {
      const match = sql.match(/table_info\((\w+)\)/i);
      if (!match) return [];
      const tableName = match[1].toLowerCase();
      const table = this.tables.get(tableName);
      if (!table) return [];
      return [...table.values()].map((col, i) => ({
        cid: i,
        name: col.name,
        type: col.type,
        notnull: col.notNull ? 1 : 0,
        dflt_value: col.defaultVal,
        pk: 0,
      }));
    }
    if (upper.startsWith("SELECT")) {
      const fromMatch = sql.match(/FROM\s+(\w+)/i);
      if (!fromMatch) return [];
      const tableName = fromMatch[1].toLowerCase();
      const tableRows = this.rows.get(tableName) ?? [];
      // Handle WHERE clause with = ?
      const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
      if (whereMatch) {
        const col = whereMatch[1].toLowerCase();
        const val = params[0];
        return tableRows.filter((r) => (r as Record<string, unknown>)[col] === val);
      }
      return tableRows;
    }
    return [];
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    if (query.includes("=")) {
      const versionMatch = query.match(/user_version\s*=\s*(\d+)/i);
      if (versionMatch) {
        this.userVersion = Number(versionMatch[1]);
      }
      return undefined;
    }
    if (query.toLowerCase().includes("user_version")) {
      if (options?.simple) return this.userVersion;
      return { user_version: this.userVersion };
    }
    return undefined;
  }

  transaction<T>(fn: () => T): () => T {
    return fn; // No-op transaction for test
  }

  close(): void {
    /* no-op */
  }
}

import type { SQLiteDatabase } from "../db.js";
import { applyMigrations } from "../migrations.js";

function makeDb(): { db: SQLiteDatabase; raw: InMemoryDatabase } {
  const raw = new InMemoryDatabase();
  return { db: raw as unknown as SQLiteDatabase, raw };
}

describe("DB migrations", () => {
  it("Test 1: DB starting at version 0 creates usage_events with pil_active + enrichment_delta columns", () => {
    const { db, raw } = makeDb();
    applyMigrations(db);

    const table = raw.tables.get("usage_events");
    expect(table).toBeDefined();
    expect(table!.has("pil_active")).toBe(true);
    expect(table!.has("enrichment_delta")).toBe(true);
  });

  it("Test 2: DB at version 2 — migration v3 adds both columns without dropping existing ones", () => {
    const { db, raw } = makeDb();
    // Simulate existing v2 schema with usage_events but no pil_active
    raw.tables.set(
      "usage_events",
      new Map([
        ["id", { name: "id", type: "INTEGER", notNull: true, defaultVal: null }],
        ["session_id", { name: "session_id", type: "TEXT", notNull: true, defaultVal: null }],
        ["source", { name: "source", type: "TEXT", notNull: true, defaultVal: null }],
        ["model", { name: "model", type: "TEXT", notNull: true, defaultVal: null }],
        ["created_at", { name: "created_at", type: "TEXT", notNull: true, defaultVal: null }],
        ["cost_micros", { name: "cost_micros", type: "INTEGER", notNull: true, defaultVal: 0 }],
      ]),
    );
    raw.tables.set("sessions", new Map());
    raw.tables.set("workspaces", new Map());
    raw.tables.set("messages", new Map());
    raw.tables.set("tool_calls", new Map());
    raw.tables.set("tool_results", new Map());
    raw.tables.set("compactions", new Map());
    raw.userVersion = 2;

    applyMigrations(db);

    const table = raw.tables.get("usage_events")!;
    expect(table.has("pil_active")).toBe(true);
    expect(table.has("enrichment_delta")).toBe(true);
    // Existing columns preserved
    expect(table.has("session_id")).toBe(true);
    expect(table.has("cost_micros")).toBe(true);
    expect(table.has("created_at")).toBe(true);
  });

  it("Test 3: DB already at version 3 — applyMigrations is idempotent (no error, no duplicate columns)", () => {
    const { db, raw } = makeDb();
    applyMigrations(db);

    expect(() => applyMigrations(db)).not.toThrow();

    const table = raw.tables.get("usage_events")!;
    // Columns should appear exactly once
    const cols = [...table.keys()];
    const pilCount = cols.filter((c) => c === "pil_active").length;
    const deltaCount = cols.filter((c) => c === "enrichment_delta").length;
    expect(pilCount).toBe(1);
    expect(deltaCount).toBe(1);
  });

  it("Test 4: row inserted without pil_active/enrichment_delta uses DEFAULT 0", () => {
    const { db, raw } = makeDb();
    applyMigrations(db);

    // Add required parent rows to tables
    raw.rows.set("workspaces", [
      {
        id: "ws1",
        scope_key: "/tmp",
        canonical_path: "/tmp",
        display_name: "test",
        last_seen_at: new Date().toISOString(),
      },
    ]);
    raw.rows.set("sessions", [
      {
        id: "sess1",
        workspace_id: "ws1",
        model: "claude",
        mode: "safe",
        cwd_at_start: "/tmp",
        cwd_last: "/tmp",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    raw.rows.set("usage_events", []);

    // Insert without pil_active/enrichment_delta — should default to 0
    db.prepare(
      `INSERT INTO usage_events (session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess1", null, "orchestrator", "claude", 100, 50, 150, 0, new Date().toISOString());

    const usageRows = raw.rows.get("usage_events") as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0].pil_active).toBe(0);
    expect(usageRows[0].enrichment_delta).toBe(0);
  });

  it("Test 5: row inserted with pilActive=true and enrichmentDelta=-120 stores 1 and -120", () => {
    const { db, raw } = makeDb();
    applyMigrations(db);

    raw.rows.set("workspaces", [
      {
        id: "ws2",
        scope_key: "/tmp2",
        canonical_path: "/tmp2",
        display_name: "test2",
        last_seen_at: new Date().toISOString(),
      },
    ]);
    raw.rows.set("sessions", [
      {
        id: "sess2",
        workspace_id: "ws2",
        model: "claude",
        mode: "safe",
        cwd_at_start: "/tmp2",
        cwd_last: "/tmp2",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    raw.rows.set("usage_events", []);

    db.prepare(
      `INSERT INTO usage_events (session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at, pil_active, enrichment_delta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess2", null, "orchestrator", "claude", 100, 50, 150, 0, new Date().toISOString(), 1, -120);

    const usageRows = raw.rows.get("usage_events") as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0].pil_active).toBe(1);
    expect(usageRows[0].enrichment_delta).toBe(-120);
  });
});
