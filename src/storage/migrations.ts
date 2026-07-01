import type { SQLiteDatabase } from "./db";

const LATEST_DB_VERSION = 9;

export function applyMigrations(db: SQLiteDatabase): void {
  const version = Number(db.pragma("user_version", { simple: true })) || 0;
  if (version >= LATEST_DB_VERSION) return;

  const migrate = db.transaction(() => {
    if (version < 1) {
      createInitialSchema(db);
      db.pragma("user_version = 1");
    }
    if (version < 2) {
      createCompactionSchema(db);
      db.pragma("user_version = 2");
    }
    if (version < 3) {
      db.exec(`
        ALTER TABLE usage_events ADD COLUMN pil_active INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE usage_events ADD COLUMN enrichment_delta INTEGER NOT NULL DEFAULT 0;
      `);
      db.pragma("user_version = 3");
    }
    if (version < 4) {
      // cache_read_tokens / cache_creation_tokens may already exist if the DB
      // was created with the v1 schema that includes them inline.  Only add
      // when missing to avoid "duplicate column name" errors.
      const cols = db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("cache_read_tokens")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!colNames.has("cache_creation_tokens")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
      }
      db.pragma("user_version = 4");
    }
    if (version < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS interaction_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          event_subtype TEXT,
          model TEXT,
          duration_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_interaction_logs_session
          ON interaction_logs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_interaction_logs_event_type
          ON interaction_logs(event_type, created_at DESC);
      `);
      db.pragma("user_version = 5");
    }
    if (version < 6) {
      // Phase O1 — record the SHAPE (not values) of providerOptions sent
      // to streamText alongside each usage event. Enables post-mortem of
      // "did this call carry store=true / promptCacheKey?" without
      // leaking key material into the DB.
      const cols = db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("provider_options_shape")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN provider_options_shape TEXT");
      }
      db.pragma("user_version = 6");
    }
    if (version < 7) {
      // Phase A5 — write-ahead persistence for assistant/user messages.
      //
      // `messages.status` carries the lifecycle of a row:
      //   - 'pending'    — write-ahead INSERT before streamText fires; lets
      //                    `recordUsage` resolve a real message_seq even when
      //                    invoked mid-stream (was NULL → forensics anomaly).
      //   - 'completed'  — turn settled, full message_json materialized.
      //   - 'errored'    — stream threw mid-flight; row left with whatever
      //                    partial content was captured.
      //
      // Nullable for back-compat: pre-A5 rows (legacy 'completed' state) read
      // back as NULL and forensics treats NULL as 'completed'.
      const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("status")) {
        db.exec("ALTER TABLE messages ADD COLUMN status TEXT");
      }
      db.pragma("user_version = 7");
    }
    if (version < 8) {
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("parent_session_id")) {
        db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON sessions(parent_session_id)");
      db.pragma("user_version = 8");
    }
    if (version < 9) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_history_fts USING fts5(
          session_id UNINDEXED,
          seq UNINDEXED,
          role UNINDEXED,
          tool_name UNINDEXED,
          content,
          tool_args,
          tool_output
        );

        CREATE TRIGGER IF NOT EXISTS t_sessions_delete_fts
        AFTER DELETE ON sessions
        BEGIN
          DELETE FROM session_history_fts WHERE session_id = old.id;
        END;
      `);
      db.pragma("user_version = 9");
    }
  });

  migrate();
}

function createInitialSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      canonical_path TEXT NOT NULL,
      git_root TEXT,
      display_name TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      title TEXT,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      cwd_at_start TEXT NOT NULL,
      cwd_last TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT,
      PRIMARY KEY (session_id, seq)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(session_id, tool_call_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tool_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_call_row_id INTEGER NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      output_kind TEXT NOT NULL,
      output_json TEXT NOT NULL,
      success INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_seq INTEGER,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      first_kept_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      tokens_before INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
      ON sessions(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent_id
      ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq
      ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session_seq
      ON tool_calls(session_id, message_seq);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session_created
      ON usage_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compactions_session_created
      ON compactions(session_id, created_at DESC);
  `);
}

function createCompactionSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      first_kept_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      tokens_before INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_compactions_session_created
      ON compactions(session_id, created_at DESC);
  `);
}
