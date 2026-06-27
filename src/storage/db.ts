import { createRequire } from "node:module";
import fs from "fs";
import os from "os";
import path from "path";
import { applyMigrations } from "./migrations";

export interface SQLiteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  pragma(query: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

let db: SQLiteDatabase | null = null;

// Sync-loadable require for runtime driver selection. We need sync because
// getDatabase() is sync and propagates through ~50 call sites; making it
// async would be a much larger refactor.
const requireSync = createRequire(import.meta.url);

export function getDatabasePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const dir = path.join(home, ".muonroi-cli");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "muonroi.db");
}

/**
 * Pick the SQLite driver at runtime so the same bundle runs on both Bun and
 * bare Node:
 *   - Bun ≥ 1.x exposes `bun:sqlite` as a built-in.
 *   - Node falls back to `better-sqlite3` (npm pkg with prebuilt binaries).
 * Loaded lazily — neither module is touched until the first DB call.
 */
function loadDriver(filename: string): SQLiteDatabase {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) {
    try {
      const { Database } = requireSync("bun:sqlite") as {
        Database: new (file: string, opts?: { create?: boolean; strict?: boolean }) => import("bun:sqlite").Database;
      };
      return new BunSqliteDatabase(filename, Database);
    } catch {
      /* fall through to better-sqlite3 */
    }
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic driver shape
    const BetterSqlite3 = requireSync("better-sqlite3") as any;
    return new BetterSqlite3Database(filename, BetterSqlite3);
  } catch (e) {
    throw new Error(
      "No SQLite driver available. Install better-sqlite3 (npm) or run muonroi-cli under Bun.\n" +
        `Underlying error: ${(e as Error).message}`,
    );
  }
}

export function getDatabase(): SQLiteDatabase {
  if (db) return db;

  const database = loadDriver(getDatabasePath());
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  applyMigrations(database);
  db = database;
  return database;
}

export function withTransaction<T>(fn: (database: SQLiteDatabase) => T): T {
  const database = getDatabase();
  return database.transaction(() => fn(database))();
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

// biome-ignore lint/suspicious/noExplicitAny: shape varies per driver
type BunDatabaseCtor = new (file: string, opts?: { create?: boolean; strict?: boolean }) => any;
// biome-ignore lint/suspicious/noExplicitAny: shape varies per driver
type BetterSqlite3Ctor = new (file: string) => any;

class BunSqliteDatabase implements SQLiteDatabase {
  // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite driver instance
  private readonly db: any;

  constructor(filename: string, Database: BunDatabaseCtor) {
    this.db = new Database(filename, { create: true, strict: true });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SQLiteStatement {
    return {
      run: (...params: unknown[]) => this.db.run(sql, normalizeBinding(params)),
      get: (...params: unknown[]) => this.db.query(sql).get(normalizeBinding(params)),
      all: (...params: unknown[]) => this.db.query(sql).all(normalizeBinding(params)),
    };
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    if (query.includes("=")) {
      this.db.exec(`PRAGMA ${query}`);
      return undefined;
    }

    const row = this.db.query(`PRAGMA ${query}`).get() as Record<string, unknown> | undefined;
    if (!options?.simple) return row;
    if (!row) return undefined;
    return Object.values(row)[0];
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * better-sqlite3 adapter — used when running on bare Node.
 * API note: better-sqlite3 puts run/get/all on the Statement (returned by
 * .prepare()), not on the DB. .pragma() is built-in. Otherwise compatible.
 */
class BetterSqlite3Database implements SQLiteDatabase {
  // biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 driver instance
  private readonly db: any;

  constructor(filename: string, BetterSqlite3: BetterSqlite3Ctor) {
    this.db = new BetterSqlite3(filename);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...spreadBinding(params)),
      get: (...params: unknown[]) => stmt.get(...spreadBinding(params)),
      all: (...params: unknown[]) => stmt.all(...spreadBinding(params)),
    };
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    return this.db.pragma(query, { simple: !!options?.simple });
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

// Bun's .run(sql, X) takes a single value or an object; better-sqlite3 spreads
// positional bindings. Normalize the inbound `params` array for each driver.
function normalizeBinding(params: unknown[]): unknown {
  if (params.length === 0) return undefined;
  return params.length === 1 ? params[0] : params;
}

function spreadBinding(params: unknown[]): unknown[] {
  // If the caller passed a single object/array as the only arg, treat as
  // named/positional bindings respectively (better-sqlite3 accepts both).
  return params;
}
