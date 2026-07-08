import { randomUUID } from "crypto";
import type { AgentMode, ResumeEntry, SessionInfo, SessionKind, SessionStatus, WorkspaceInfo } from "../types/index";
import { getDatabase, type SQLiteDatabase } from "./db";
import { sweepStalePendingRows } from "./transcript";
import { ensureWorkspace } from "./workspaces";

// Best-effort sweep is done once per process — repeated openSession() calls
// (e.g. user runs /sessions then picks one) do not re-scan the DB.
let _sweepDone = false;

interface SessionRow {
  id: string;
  workspace_id: string;
  title: string | null;
  model: string;
  mode: AgentMode;
  cwd_at_start: string;
  cwd_last: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  kind: SessionKind;
  root_session_id: string | null;
}

export class SessionStore {
  private readonly workspace: WorkspaceInfo;

  constructor(cwd: string) {
    this.workspace = ensureWorkspace(cwd);
  }

  getWorkspace(): WorkspaceInfo {
    return this.workspace;
  }

  openSession(selector: string | undefined, model: string, mode: AgentMode, cwd: string): SessionInfo {
    // One-shot cleanup of write-ahead rows orphaned by a prior process that
    // was killed mid-turn (Ctrl+C on `gh run watch`, OOM, taskkill /F).
    // Without this, tool_calls and messages stay status='pending' forever,
    // skewing forensics + filling the DB with dead state.
    if (!_sweepDone) {
      _sweepDone = true;
      const swept = sweepStalePendingRows();
      if (swept.toolCalls > 0 || swept.messages > 0) {
        console.error(
          `[muonroi-cli] swept stale write-ahead rows from prior run: ${swept.toolCalls} tool_calls, ${swept.messages} messages`,
        );
      }
    }

    if (!selector) {
      return this.createSession(model, mode, cwd);
    }

    if (selector === "latest") {
      const latest = this.getLatestSession();
      return latest ?? this.createSession(model, mode, cwd);
    }

    const session = this.getSessionById(selector);
    if (!session) {
      throw new Error(`Session "${selector}" was not found.`);
    }

    this.touchSession(session.id, cwd);
    return this.getRequiredSession(session.id);
  }

  createSession(model: string, mode: AgentMode, cwd: string): SessionInfo {
    const now = new Date().toISOString();
    const id = createSessionId();
    const db = getDatabase();

    db.prepare(`
      INSERT INTO sessions (
        id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at, kind, root_session_id
      ) VALUES (
        @id, @workspace_id, NULL, @model, @mode, @cwd_at_start, @cwd_last, 'active', @created_at, @updated_at, 'conversation', @id
      )
    `).run({
      id,
      workspace_id: this.workspace.id,
      model,
      mode,
      cwd_at_start: cwd,
      cwd_last: cwd,
      created_at: now,
      updated_at: now,
    });

    return this.getRequiredSession(id);
  }

  /**
   * Link a freshly-created session as a child of `parentId`, tagging its `kind`
   * and inheriting the parent's `root_session_id` so the whole tree shares one
   * root. Replaces the ad-hoc `UPDATE sessions SET parent_session_id = ?` the
   * orchestrator previously hand-wrote (which never set kind/root).
   */
  linkChild(childId: string, parentId: string, kind: SessionKind): void {
    const db = getDatabase();
    const parent = db.prepare("SELECT root_session_id FROM sessions WHERE id = ?").get(parentId) as
      | { root_session_id: string | null }
      | undefined;
    const root = parent?.root_session_id ?? parentId;
    db.prepare(
      "UPDATE sessions SET parent_session_id = ?, kind = ?, root_session_id = ?, updated_at = ? WHERE id = ?",
    ).run(parentId, kind, root, new Date().toISOString(), childId);
  }

  listRecentSessions(limit = 20): ResumeEntry[] {
    return queryResumeList(getDatabase(), this.workspace.id, limit);
  }

  getLatestSession(): SessionInfo | null {
    const row = getDatabase()
      .prepare(`
      SELECT id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at
      FROM sessions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
      .get(this.workspace.id) as SessionRow | undefined;

    return row ? toSessionInfo(row) : null;
  }

  getSessionById(id: string): SessionInfo | null {
    const row = getDatabase()
      .prepare(`
      SELECT id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `)
      .get(id) as SessionRow | undefined;

    return row ? toSessionInfo(row) : null;
  }

  getRequiredSession(id: string): SessionInfo {
    const session = this.getSessionById(id);
    if (!session) {
      throw new Error(`Session "${id}" was not found.`);
    }
    return session;
  }

  setStatus(id: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`
      UPDATE sessions
      SET status = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(status, now, id);
  }

  setTitle(id: string, title: string | null): void {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`
      UPDATE sessions
      SET title = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(title, now, id);
  }

  setModel(id: string, model: string): void {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`
      UPDATE sessions
      SET model = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(model, now, id);
  }

  setMode(id: string, mode: AgentMode): void {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`
      UPDATE sessions
      SET mode = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(mode, now, id);
  }

  touchSession(id: string, cwd: string): void {
    getDatabase()
      .prepare(`
      UPDATE sessions
      SET cwd_last = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(cwd, new Date().toISOString(), id);
  }
}

function createSessionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    model: row.model,
    mode: row.mode,
    cwdAtStart: row.cwd_at_start,
    cwdLast: row.cwd_last,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface ResumeRow extends SessionRow {
  resume_id: string;
}

/**
 * One row per conversation tree for the `/sessions` resume picker.
 *
 * - Groups by `root_session_id`; sub-agent sessions (`kind='subagent'`) are
 *   internal side-conversations and are excluded entirely.
 * - Only trees with at least one persisted message surface (hides empty stub
 *   rows every keyless CLI launch creates).
 * - The row's `title`/`created_at` come from the tree ROOT; `resume_id`,
 *   `model`, `updated_at`, `status` come from the LATEST leaf (the active tail
 *   of a rotation chain), so Enter resumes into the live session, not the
 *   compacted root. Ordered by tree activity, newest first.
 */
export function queryResumeList(db: SQLiteDatabase, workspaceId: string, limit: number): ResumeEntry[] {
  const rows = db
    .prepare(`
      WITH candidates AS (
        SELECT s.id, s.workspace_id, s.title, s.model, s.mode, s.cwd_at_start,
               s.cwd_last, s.status, s.created_at, s.updated_at, s.root_session_id
        FROM sessions s
        WHERE s.workspace_id = ?
          AND s.kind != 'subagent'
          AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
      ),
      ranked AS (
        SELECT c.*,
               ROW_NUMBER() OVER (
                 PARTITION BY c.root_session_id
                 ORDER BY c.updated_at DESC, c.id DESC
               ) AS rn
        FROM candidates c
      )
      SELECT
        r.root_session_id                          AS id,
        r.id                                       AS resume_id,
        COALESCE(root.title, r.title)              AS title,
        r.model                                    AS model,
        r.mode                                     AS mode,
        COALESCE(root.cwd_at_start, r.cwd_at_start) AS cwd_at_start,
        r.cwd_last                                 AS cwd_last,
        r.status                                   AS status,
        COALESCE(root.created_at, r.created_at)    AS created_at,
        r.updated_at                               AS updated_at,
        r.workspace_id                             AS workspace_id
      FROM ranked r
      LEFT JOIN sessions root ON root.id = r.root_session_id
      WHERE r.rn = 1
      ORDER BY r.updated_at DESC
      LIMIT ?
    `)
    .all(workspaceId, limit) as ResumeRow[];
  return rows.map(toResumeEntry);
}

function toResumeEntry(row: ResumeRow): ResumeEntry {
  return { ...toSessionInfo(row), resumeId: row.resume_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// B-3: Re-export getSessionDir from the isolated session-dir module.
//
// getSessionDir is kept in a separate file (no bun:sqlite import) so it can be
// safely loaded in Vitest (Node) test environments without pulling in bun:sqlite.
// ─────────────────────────────────────────────────────────────────────────────

export { getSessionDir } from "./session-dir.js";
