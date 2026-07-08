# Clean Resume — Thread-Aware Session List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/sessions` resume picker show one row per logical conversation (rotation chains collapsed, sub-agent spawns hidden), resuming into the latest leaf, with titles inherited from the tree root.

**Architecture:** Reuse the existing `sessions.parent_session_id` self-FK — no storage redesign. A light v10 migration adds `kind` (discriminator) + denormalized `root_session_id`, backfilled for existing DBs. The resume query groups by `root_session_id`; a pure `queryResumeList()` function holds the SQL so it can be unit-tested against a real SQLite DB. Orchestrator rotation/spawn paths stamp the correct `kind` via a new `SessionStore.linkChild()` helper.

**Tech Stack:** TypeScript, SQLite (`bun:sqlite` under Bun / `better-sqlite3` under Node), Vitest (unit), agent-harness (E2E), OpenTUI/React (picker modal).

## Global Constraints

- Zero-hardcode: never hardcode model/provider IDs (`CLAUDE.md`). N/A to this plan (no model literals introduced).
- No silent catch: every `try/catch` logs module + operation + `err.message` (project `CLAUDE.md`).
- Core/UI separation: `src/storage/*` must not import `src/ui` or opentui/react (memory `feedback_core_ui_separation`).
- STRICT tables: `sessions` is a `STRICT` table — `ALTER TABLE ADD COLUMN` with a constant `DEFAULT` is legal; a `NOT NULL` added column MUST carry a constant default.
- SQLite ≥ 3.25 (window functions) — satisfied by both bundled drivers.
- Pre-push: `bunx tsc --noEmit` clean + `bunx vitest run` green + harness spec on Windows named-pipe (and WSL for POSIX) before any push (`CLAUDE.md` Pre-Push Test Gate).
- `SessionKind` string union is the ONLY new string-literal set; it lives in `src/types/index.ts` as a type definition (allowed literal location).

---

### Task 1: Migration v10 — `kind` + `root_session_id` columns, index, backfill

**Files:**
- Modify: `src/storage/migrations.ts` (bump `LATEST_DB_VERSION`, add `version < 10` block)
- Test: `src/storage/__tests__/migrations.test.ts` (fake-DB: columns exist)
- Test (new): `src/storage/__tests__/resume-backfill.test.ts` (real better-sqlite3: backfill correctness)

**Interfaces:**
- Consumes: existing `applyMigrations(db: SQLiteDatabase)`, `SQLiteDatabase` from `src/storage/db.ts`.
- Produces: `sessions.kind TEXT NOT NULL DEFAULT 'conversation'`, `sessions.root_session_id TEXT`, index `idx_sessions_root`. After migration every session row has a non-NULL `root_session_id` and a `kind` ∈ `'conversation' | 'rotation' | 'subagent'`.

- [x] **Step 1: Write the failing fake-DB test** (append to `migrations.test.ts`, inside `describe("DB migrations", …)`)

```ts
  it("Test 7: v10 adds kind + root_session_id columns to sessions", () => {
    const { db, raw } = makeDb();
    applyMigrations(db);

    const table = raw.tables.get("sessions")!;
    expect(table.has("kind")).toBe(true);
    expect(table.has("root_session_id")).toBe(true);
  });
```

- [x] **Step 2: Run it and verify it fails**

Run: `bunx vitest run src/storage/__tests__/migrations.test.ts -t "v10 adds kind"`
Expected: FAIL — `kind` column not present (migration not written yet).

- [x] **Step 3: Bump the version and add the v10 migration block** in `src/storage/migrations.ts`

Change line 3:

```ts
const LATEST_DB_VERSION = 10;
```

Insert this block immediately after the `if (version < 9) { … }` block (after line 121, before the closing `});` of the `migrate` transaction):

```ts
    if (version < 10) {
      // Thread-aware resume. The resume picker groups sessions by conversation
      // tree; `kind` distinguishes the two kinds of child (both previously only
      // set parent_session_id, indistinguishable) and `root_session_id`
      // denormalizes the tree root so the picker groups without a recursive CTE.
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("kind")) {
        db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation'");
      }
      if (!colNames.has("root_session_id")) {
        db.exec("ALTER TABLE sessions ADD COLUMN root_session_id TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(workspace_id, root_session_id)");

      backfillSessionTrees(db);

      db.pragma("user_version = 10");
    }
```

Add this helper at the bottom of the file (after `createCompactionSchema`):

```ts
/**
 * Backfill kind + root_session_id for pre-v10 rows.
 *
 * - Rows with no parent become their own root (kind 'conversation').
 * - Rows WITH a parent are marked 'rotation' — historical data cannot tell
 *   rotation apart from sub-agent spawns, and marking them 'rotation' collapses
 *   them under their root rather than risking hiding a real conversation.
 * - root_session_id propagates down the parent chain via a bounded fixpoint
 *   loop (chains are shallow; the bound also guards against FK cycles).
 */
function backfillSessionTrees(db: SQLiteDatabase): void {
  // Roots: own id, keep default kind 'conversation'.
  db.exec("UPDATE sessions SET root_session_id = id WHERE parent_session_id IS NULL AND root_session_id IS NULL");
  // Children of a real parent → rotation (default kind was 'conversation').
  db.exec("UPDATE sessions SET kind = 'rotation' WHERE parent_session_id IS NOT NULL");

  // Propagate root down the chain until no row changes (bounded to 100 passes).
  for (let i = 0; i < 100; i++) {
    db.exec(`
      UPDATE sessions
      SET root_session_id = (SELECT p.root_session_id FROM sessions p WHERE p.id = sessions.parent_session_id)
      WHERE root_session_id IS NULL
        AND parent_session_id IS NOT NULL
        AND (SELECT p.root_session_id FROM sessions p WHERE p.id = sessions.parent_session_id) IS NOT NULL
    `);
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE root_session_id IS NULL AND parent_session_id IS NOT NULL")
      .get() as { c: number } | undefined;
    if (!remaining || remaining.c === 0) break;
  }

  // Any leftover (orphaned/cyclic parent chains) → treat as its own root.
  db.exec("UPDATE sessions SET root_session_id = id WHERE root_session_id IS NULL");
}
```

- [x] **Step 4: Run the fake-DB test to verify it passes**

Run: `bunx vitest run src/storage/__tests__/migrations.test.ts`
Expected: PASS (all 7 tests). The fake DB ignores the UPDATE/SELECT statements and the loop breaks immediately (`.get()` returns `undefined`), so it only asserts the ADD COLUMNs.

- [x] **Step 5: Write the failing real-DB backfill test** — create `src/storage/__tests__/resume-backfill.test.ts`

```ts
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

    const rows = handle.db
      .prepare("SELECT id, kind, root_session_id FROM sessions ORDER BY id")
      .all() as Array<{ id: string; kind: string; root_session_id: string }>;
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
```

- [x] **Step 6: Run the real-DB test to verify it passes**

Run: `bunx vitest run src/storage/__tests__/resume-backfill.test.ts`
Expected: PASS (2 tests). If better-sqlite3 native binding fails to load, the test errors at `require("better-sqlite3")` — that is an environment problem, not a logic failure; resolve by `bun install` / rebuilding the native module before continuing.

- [x] **Step 7: Commit**

```bash
git add src/storage/migrations.ts src/storage/__tests__/migrations.test.ts src/storage/__tests__/resume-backfill.test.ts
git commit -m "feat(storage): v10 migration adds session kind + root_session_id with backfill"
```

---

### Task 2: `SessionKind` type + `createSession` defaults + `linkChild` helper

**Files:**
- Modify: `src/types/index.ts` (add `SessionKind`; add `ResumeEntry`)
- Modify: `src/storage/sessions.ts` (`SessionRow` gains fields; `createSession` writes `kind`/`root_session_id`; new `linkChild`)
- Test (new): `src/storage/__tests__/session-store-link.test.ts` (real better-sqlite3)

**Interfaces:**
- Consumes: `applyMigrations`, `SQLiteDatabase` from Task 1's schema.
- Produces:
  - `type SessionKind = "conversation" | "rotation" | "subagent"` (in `src/types/index.ts`).
  - `SessionStore.linkChild(childId: string, parentId: string, kind: SessionKind): void` — stamps `parent_session_id`, `kind`, and `root_session_id` (= parent's root) on the child in one statement.
  - `createSession` now INSERTs `kind='conversation'`, `root_session_id = <new id>`.

- [x] **Step 1: Add the `SessionKind` type** in `src/types/index.ts` immediately after line 612 (`export type SessionStatus = …`)

```ts
export type SessionKind = "conversation" | "rotation" | "subagent";
```

- [x] **Step 2: Write the failing helper test** — create `src/storage/__tests__/session-store-link.test.ts`

```ts
/**
 * Real-SQLite verification of createSession defaults + linkChild root propagation.
 * Points getDatabasePath at a temp HOME so getDatabase() opens a real
 * better-sqlite3 file DB (bun:sqlite is unavailable under vitest/Node).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db.js";
import { SessionStore } from "../sessions.js";

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-link-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  closeDatabase();
  getDatabase(); // trigger migrations against the temp DB
});

afterEach(() => {
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("SessionStore.createSession + linkChild", () => {
  it("createSession defaults kind='conversation' and root_session_id=id", () => {
    const store = new SessionStore(tmpHome);
    const s = store.createSession("m", "agent", tmpHome);
    const row = getDatabase().prepare("SELECT kind, root_session_id FROM sessions WHERE id = ?").get(s.id) as {
      kind: string;
      root_session_id: string;
    };
    expect(row.kind).toBe("conversation");
    expect(row.root_session_id).toBe(s.id);
  });

  it("linkChild stamps parent, kind, and inherits the parent's root", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("m", "agent", tmpHome);
    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, root.id, "rotation");

    const row = getDatabase()
      .prepare("SELECT parent_session_id, kind, root_session_id FROM sessions WHERE id = ?")
      .get(child.id) as { parent_session_id: string; kind: string; root_session_id: string };
    expect(row.parent_session_id).toBe(root.id);
    expect(row.kind).toBe("rotation");
    expect(row.root_session_id).toBe(root.id);

    // A grandchild inherits the same root, not its immediate parent's id.
    const grand = store.createSession("m", "agent", tmpHome);
    store.linkChild(grand.id, child.id, "rotation");
    const grandRow = getDatabase().prepare("SELECT root_session_id FROM sessions WHERE id = ?").get(grand.id) as {
      root_session_id: string;
    };
    expect(grandRow.root_session_id).toBe(root.id);
  });
});
```

- [x] **Step 3: Run it and verify it fails**

Run: `bunx vitest run src/storage/__tests__/session-store-link.test.ts`
Expected: FAIL — `linkChild` is not a function / `root_session_id` column not written by `createSession`.

- [x] **Step 4: Update `createSession` and add `linkChild`** in `src/storage/sessions.ts`

Extend the `SessionRow` interface (after line 21, before the closing `}`):

```ts
  kind: SessionKind;
  root_session_id: string | null;
```

Update the import on line 2 to include `SessionKind`:

```ts
import type { AgentMode, SessionInfo, SessionKind, SessionStatus, WorkspaceInfo } from "../types/index";
```

Replace the `createSession` INSERT (lines 73-88) with:

```ts
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
```

Add the `linkChild` method immediately after `createSession` (before `listRecentSessions`):

```ts
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
```

- [x] **Step 5: Run the helper test to verify it passes**

Run: `bunx vitest run src/storage/__tests__/session-store-link.test.ts`
Expected: PASS (2 tests).

- [x] **Step 6: Commit**

```bash
git add src/types/index.ts src/storage/sessions.ts src/storage/__tests__/session-store-link.test.ts
git commit -m "feat(storage): SessionKind + createSession root defaults + linkChild helper"
```

---

### Task 3: `queryResumeList` (tree-collapsing SQL) + rewired `listRecentSessions`

**Files:**
- Modify: `src/types/index.ts` (add `ResumeEntry`)
- Modify: `src/storage/sessions.ts` (`queryResumeList` pure fn; `listRecentSessions` wrapper; `toResumeEntry`)
- Test (new): `src/storage/__tests__/resume-list.test.ts` (real better-sqlite3)

**Interfaces:**
- Consumes: `SessionStore` schema (kind/root_session_id), `SessionInfo`.
- Produces:
  - `interface ResumeEntry extends SessionInfo { resumeId: string }` (in `src/types/index.ts`) — `id` is the tree root id (display identity), `resumeId` is the leaf to relaunch, `title` is the root's title, `updatedAt`/`model` are the leaf's.
  - `export function queryResumeList(db: SQLiteDatabase, workspaceId: string, limit: number): ResumeEntry[]`.
  - `SessionStore.listRecentSessions(limit?: number): ResumeEntry[]` (return type widened from `SessionInfo[]`).

- [x] **Step 1: Add the `ResumeEntry` type** in `src/types/index.ts` immediately after the `SessionInfo` interface (after line 635)

```ts
/**
 * One row in the `/sessions` resume picker: a whole conversation tree collapsed
 * to a single entry. `id`/`title`/`createdAt` describe the tree root; `resumeId`
 * is the latest leaf to relaunch; `model`/`updatedAt`/`status` describe that leaf.
 */
export interface ResumeEntry extends SessionInfo {
  resumeId: string;
}
```

- [x] **Step 2: Write the failing query test** — create `src/storage/__tests__/resume-list.test.ts`

```ts
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
      .run(id, "ws1", parent, title, "gpt", "agent", "/tmp", "/tmp", "active", "2026-07-08T00:00:00Z", updated, kind, root);
  const insMsg = (sid: string) =>
    db
      .prepare(
        "INSERT INTO messages (session_id, seq, role, message_json, created_at, status) VALUES (?,?,?,?,?,?)",
      )
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
```

- [x] **Step 3: Run it and verify it fails**

Run: `bunx vitest run src/storage/__tests__/resume-list.test.ts`
Expected: FAIL — `queryResumeList` is not exported.

- [x] **Step 4: Implement `queryResumeList` + rewire `listRecentSessions`** in `src/storage/sessions.ts`

Update the import on line 2 to include `ResumeEntry` and `SQLiteDatabase`:

```ts
import type { AgentMode, ResumeEntry, SessionInfo, SessionKind, SessionStatus, WorkspaceInfo } from "../types/index";
```

Add to the imports near the top (line 3 area):

```ts
import { getDatabase, type SQLiteDatabase } from "./db";
```

Replace `listRecentSessions` (lines 103-115) with a thin wrapper:

```ts
  listRecentSessions(limit = 20): ResumeEntry[] {
    return queryResumeList(getDatabase(), this.workspace.id, limit);
  }
```

Add the pure function + row mapper near the bottom of the file (after `toSessionInfo`):

```ts
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
```

Note: `toSessionInfo` reads `row.id` (the aliased root id) for `SessionInfo.id`, which is exactly the tree display identity we want.

- [x] **Step 5: Run the query test to verify it passes**

Run: `bunx vitest run src/storage/__tests__/resume-list.test.ts`
Expected: PASS (2 tests).

- [x] **Step 6: Typecheck the storage layer**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (`listRecentSessions` now returns `ResumeEntry[]`, a superset of `SessionInfo` — assignable wherever `SessionInfo[]` was consumed; the picker prop is tightened in Task 6.)

- [x] **Step 7: Commit**

```bash
git add src/types/index.ts src/storage/sessions.ts src/storage/__tests__/resume-list.test.ts
git commit -m "feat(storage): queryResumeList collapses conversation trees for resume picker"
```

---

### Task 4: Orchestrator rotation + spawn paths stamp `kind` via `linkChild`

**Files:**
- Modify: `src/orchestrator/orchestrator.ts` (rotation path ~line 2892; spawn path ~line 2972)
- Test: existing `src/orchestrator/__tests__/sub-session-delegation.test.ts` (adjust the assertion that sniffs the raw UPDATE)

**Interfaces:**
- Consumes: `SessionStore.linkChild(childId, parentId, kind)` from Task 2.
- Produces: rotation children persisted with `kind='rotation'`; sub-agent children with `kind='subagent'`; both with `root_session_id` = parent's root.

- [x] **Step 1: Inspect the existing contract test**

Run: `bunx vitest run src/orchestrator/__tests__/sub-session-delegation.test.ts`
Expected: PASS currently. Read the test around the assertion referenced in the design (`line 283` — asserts the exact `UPDATE sessions SET parent_session_id = ?`). This assertion changes because we route through `linkChild`.

- [x] **Step 2: Replace the rotation-path raw UPDATE** in `src/orchestrator/orchestrator.ts`

Find (around line 2890-2892):

```ts
        const newSession = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
        const db = getDatabase();
        db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(parentSessionId, newSession.id);
```

Replace with:

```ts
        const newSession = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
        const db = getDatabase();
        this.sessionStore.linkChild(newSession.id, parentSessionId, "rotation");
```

(The `db` const is still used just below for `appendCompaction`/other calls — leave it. If `db` becomes unused after this edit, remove the `const db = getDatabase();` line to satisfy lint.)

- [x] **Step 3: Replace the spawn-path raw UPDATE** in `src/orchestrator/orchestrator.ts`

Find (around line 2971-2972):

```ts
          const newSession = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
          db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(parentSessionId, newSession.id);
          subSessionId = newSession.id;
```

Replace with:

```ts
          const newSession = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
          this.sessionStore.linkChild(newSession.id, parentSessionId, "subagent");
          subSessionId = newSession.id;
```

(Here `db` is still used earlier in the same block for the active-child lookup, so keep it.)

- [x] **Step 4: Update the contract test assertion** in `src/orchestrator/__tests__/sub-session-delegation.test.ts`

Locate the assertion that matches the raw `UPDATE sessions SET parent_session_id = ?` string and replace it with an assertion that `linkChild` was invoked with the expected `(childId, parentId, kind)`. Concretely, if the test spies on `sessionStore`, assert:

```ts
expect(linkChildSpy).toHaveBeenCalledWith(expect.any(String), parentSessionId, "subagent");
```

If the test asserts against captured SQL (via a mocked `getDatabase().prepare`), remove the now-obsolete expectation on the `UPDATE sessions SET parent_session_id` SQL for the fork path and instead assert `linkChild` on the mocked `SessionStore`. Keep every other assertion (resume-vs-abandon at lines ~387/505) unchanged — those paths still run the same `SELECT … WHERE parent_session_id = ? AND status='active'` and `UPDATE … status='abandoned'` SQL, which is untouched.

- [x] **Step 5: Run the orchestrator sub-session tests**

Run: `bunx vitest run src/orchestrator/__tests__/sub-session-delegation.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/orchestrator/__tests__/sub-session-delegation.test.ts
git commit -m "feat(orchestrator): tag rotation/sub-agent children via linkChild(kind)"
```

---

### Task 5: Title hygiene — stop persisting `{}` / JSON-ish fallback titles

**Files:**
- Modify: `src/orchestrator/orchestrator.ts` (`fallbackTitle`, lines 207-210)
- Test (new): `src/orchestrator/__tests__/fallback-title.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fallbackTitle(userMessage: string): string` returns `""` when the first message is empty or JSON-ish (`{…}` / `[…]`), so `generateTitle` (which persists only truthy titles, `orchestrator.ts:755`) leaves `title = NULL` → picker shows a clean `(untitled)` instead of literal `{}`.

- [x] **Step 1: Write the failing test** — create `src/orchestrator/__tests__/fallback-title.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fallbackTitle } from "../orchestrator.js";

describe("fallbackTitle hygiene", () => {
  it("returns '' for a JSON-object first message so no {} title is persisted", () => {
    expect(fallbackTitle("{}")).toBe("");
    expect(fallbackTitle('  { "op": "resume" } ')).toBe("");
  });

  it("returns '' for a JSON-array or empty message", () => {
    expect(fallbackTitle("[1,2,3]")).toBe("");
    expect(fallbackTitle("   ")).toBe("");
  });

  it("keeps a normal prose message (truncated)", () => {
    expect(fallbackTitle("build a counter component")).toBe("build a counter component");
  });
});
```

- [x] **Step 2: Export `fallbackTitle` and run the test to see it fail**

In `src/orchestrator/orchestrator.ts`, change the declaration on line 208 from `function fallbackTitle(` to `export function fallbackTitle(`.

Run: `bunx vitest run src/orchestrator/__tests__/fallback-title.test.ts`
Expected: FAIL — `fallbackTitle("{}")` currently returns `"{}"`, not `""`.

- [x] **Step 3: Implement the hygiene guard** — replace `fallbackTitle` (lines 207-210)

```ts
/** Deterministic fallback title: truncated first user message, or "" when the
 *  message is empty or a JSON-ish payload (so the caller leaves title = NULL
 *  and the picker renders a clean "(untitled)" instead of a literal "{}"). */
export function fallbackTitle(userMessage: string): string {
  const trimmed = userMessage.trim();
  if (!trimmed) return "";
  // JSON object/array payloads (programmatic first messages) make useless titles.
  if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) return "";
  return trimmed.slice(0, 60).trim();
}
```

Note: the previous `|| "New session"` default is intentionally dropped — an empty return now signals "leave NULL". The `generateTitle` method already returns the literal `"New session"` when no provider exists (`orchestrator.ts:750`), so the no-provider path is unaffected.

- [x] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/orchestrator/__tests__/fallback-title.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/orchestrator/__tests__/fallback-title.test.ts
git commit -m "fix(orchestrator): suppress {} / JSON-ish fallback session titles"
```

---

### Task 6: Picker resumes the leaf + short id; wire `ResumeEntry` through the UI

**Files:**
- Modify: `src/ui/modals/session-picker-modal.tsx` (prop type → `ResumeEntry[]`; short id; keep display of root title)
- Modify: `src/ui/use-app-logic.tsx` (resume handler uses `picked.resumeId`; picker list state type)
- Modify: `src/ui/containers/modals-layer.tsx` (tighten `sessionPickerList` type — optional, it is `any`)

**Interfaces:**
- Consumes: `ResumeEntry` (Task 3), `SessionStore.listRecentSessions(): ResumeEntry[]`.
- Produces: Enter in the picker relaunches `picked.resumeId` (leaf), not `picked.id` (root). Display id shortened to 8 chars.

- [x] **Step 1: Update the picker modal prop type + id label** in `src/ui/modals/session-picker-modal.tsx`

Change the import on line 2:

```ts
import type { ResumeEntry } from "../../types/index.js";
```

Change the `sessions` prop type (line 19) from `sessions: SessionInfo[];` to:

```ts
  sessions: ResumeEntry[];
```

Change `idLabel` (lines 71-75) — replace the full-id comment + assignment with:

```ts
                // Short 8-char id — the tree's root id, enough to disambiguate
                // rows without crowding the model column.
                const idLabel = s.id.slice(0, 8);
```

(Everything else — timestamp, title fallback to `(untitled)` — stays. The list now shows the root title and the tree's latest-activity timestamp because those are what `queryResumeList` returns.)

- [x] **Step 2: Point the resume handler at the leaf** in `src/ui/use-app-logic.tsx`

In the `key.name === "return"` branch (around lines 6361-6379), the relaunch currently calls `onRelaunch(picked.id)`. Change the relaunch target to the leaf while keeping the toast on the root id for user familiarity:

Find:

```ts
              if (onRelaunch) {
                onRelaunch(picked.id);
```

Replace with:

```ts
              if (onRelaunch) {
                onRelaunch(picked.resumeId);
```

(Leave the `pushToast(... picked.id ...)` line as-is — the root id is the stable conversation identity the user recognizes.)

If a legacy fallback branch a few lines below also calls `relaunchWithSession(picked.id, …)`, change that argument to `picked.resumeId` too, so both paths resume the leaf.

- [x] **Step 3: Tighten the picker-list state type** (if explicitly typed)

Search `src/ui/use-app-logic.tsx` for the `sessionPickerList` state declaration and `setSessionPickerList`. If it is typed `SessionInfo[]`, change to `ResumeEntry[]`:

Run: `bunx grep-equivalent` — use the editor to locate `useState<SessionInfo[]>` / `sessionPickerList`. Update the generic to `ResumeEntry[]`. If it is untyped/`any`, no change needed. In `src/ui/containers/modals-layer.tsx:66`, optionally change `sessionPickerList: any;` to `sessionPickerList: ResumeEntry[];` and import the type.

- [x] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [x] **Step 5: Lint the semantic wrappers** (picker uses `<Semantic>`)

Run: `bun run lint:semantic`
Expected: pass (no new unwrapped interactive elements — the modal already wraps rows).

- [x] **Step 6: Commit**

```bash
git add src/ui/modals/session-picker-modal.tsx src/ui/use-app-logic.tsx src/ui/containers/modals-layer.tsx
git commit -m "feat(ui): resume picker collapses trees, resumes latest leaf, short id"
```

---

### Task 7: Harness E2E — resume picker shows collapsed, clean rows

**Files:**
- Test (new): `tests/harness/session-picker.spec.ts`
- Reference: `tests/harness/helpers.ts` (`spawnHarness`), `CLAUDE.md` "Event-driven E2E pattern"

**Interfaces:**
- Consumes: the running TUI via the harness driver; the `session-picker` / `session-item-*` Semantic ids from `session-picker-modal.tsx`.
- Produces: a regression spec asserting the picker renders collapsed rows with no `(untitled)`/`{}` noise for a rotation tree.

- [x] **Step 1: Write the spec** — create `tests/harness/session-picker.spec.ts`

The cleanest deterministic setup seeds the DB directly (a real rotation tree) against a temp `HOME`, then launches the harness pointed at that same `HOME`, and opens `/sessions`. Follow the greenfield-temp-cwd pattern from `CLAUDE.md` caveat #2.

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers";

describe("resume picker collapses conversation trees", () => {
  let home: string;
  let harness: Awaited<ReturnType<typeof spawnHarness>>;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-resume-e2e-"));
    // Seed a rotation tree + a sub-agent + a stub into the temp DB BEFORE launch.
    // Use the same storage layer the app uses so the schema/migrations match.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const { SessionStore } = await import("../../src/storage/sessions.js");
    const { getDatabase, closeDatabase } = await import("../../src/storage/db.js");
    const store = new SessionStore(home);
    const root = store.createSession("gpt", "agent", home);
    store.setTitle(root.id, "Refactor auth flow");
    const leaf = store.createSession("gpt", "agent", home);
    store.linkChild(leaf.id, root.id, "rotation");
    const sub = store.createSession("gpt", "agent", home);
    store.linkChild(sub.id, root.id, "subagent");
    // Give each a message so the resume filter surfaces the tree.
    const db = getDatabase();
    for (const sid of [root.id, leaf.id, sub.id]) {
      db.prepare(
        "INSERT INTO messages (session_id, seq, role, message_json, created_at, status) VALUES (?,1,'user','{}',?,'completed')",
      ).run(sid, new Date().toISOString());
    }
    closeDatabase();

    harness = await spawnHarness({ cwd: home, env: { HOME: home, USERPROFILE: home } });
    await harness.driver.wait_for({ idle: true, timeoutMs: 20_000 });
  }, 30_000);

  afterAll(() => {
    harness?.proc?.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("shows one collapsed row for the tree, no (untitled)/{} noise", async () => {
    harness.driver.type("/sessions");
    harness.driver.press("Enter");
    await harness.driver.wait_for({ selector: "id=session-picker", timeoutMs: 8_000 });

    const items = harness.driver.queryAll("role=listitem");
    // Exactly one row: the collapsed tree. Sub-agent excluded; leaf collapsed
    // into the root; no empty-stub sessions.
    expect(items.length).toBe(1);
    const name = items[0]?.name ?? "";
    expect(name).toContain("Refactor auth flow"); // root title, inherited
    expect(name).not.toContain("(untitled)");
    expect(name).not.toContain("{}");
  });
});
```

Note: confirm `spawnHarness` accepts an `env` option; if its signature differs, set `process.env.HOME`/`USERPROFILE` before `spawnHarness` (as above) so the child inherits them, and drop the `env` argument. Check `tests/harness/helpers.ts` for the exact option shape before finalizing.

- [x] **Step 2: Run the spec on Windows (named-pipe transport)**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/session-picker.spec.ts`
Expected: PASS. If the picker shows 0 rows, the seeded messages/workspace id don't match the launch cwd's workspace — ensure the harness launches with `cwd: home` so `ensureWorkspace(home)` yields the same `workspace_id` the seed used.

- [x] **Step 3: Run the spec on WSL (POSIX fd 3/4 transport)**

Run: `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest -c vitest.harness.config.ts run tests/harness/session-picker.spec.ts'`
Expected: PASS. (Per `CLAUDE.md`, WSL needs a Linux-side checkout + `git pull` first.)

- [x] **Step 4: Commit**

```bash
git add tests/harness/session-picker.spec.ts
git commit -m "test(harness): resume picker collapses trees, hides sub-agents + noise"
```

---

### Task 8: Full-suite gate + self-verify (pre-push)

**Files:** none (verification only)

- [x] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [x] **Step 2: Full unit suite** (Pre-Push Test Gate — must be 0 failures)

Run: `bunx vitest run`
Expected: PASS. Investigate any red test before proceeding — no pushing on red (memory `feedback_test_gate_strict`).

- [x] **Step 3: Harness suite**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/`
Expected: PASS (new `session-picker.spec.ts` green alongside the rest).

- [x] **Step 4: Self-verify the touched UI surface** (picker modal changed)

Run: `bun run src/index.ts self-verify --since HEAD~8 --max 4`
Expected: touched Semantic ids drive clean; emits `tests/harness/auto/*.spec.ts` for passing scenarios. A failure here is a real regression — fix before push.

- [x] **Step 5: Skip-ratio lint** (added a harness spec, not a skip — should stay green)

Run: `bun run lint:harness-skips`
Expected: pass.

---

## Self-Review

**Spec coverage:**
- Migration v10 (`kind` + `root_session_id` + backfill) → Task 1. ✓
- Write `kind`/`root` at source (createSession + linkChild) → Task 2. ✓
- Resume query collapses trees, hides sub-agents, resumes leaf, title from root → Task 3. ✓
- Orchestrator rotation/spawn stamp kind → Task 4. ✓
- Title hygiene (`{}`) → Task 5. ✓
- UI resumes leaf + short id → Task 6. ✓
- Tests: unit (Tasks 1-3,5), migration (Task 1), harness E2E (Task 7), full gate (Task 8). ✓
- Out-of-scope items (tree UI, sub-agent resume, FTS, transport) — untouched. ✓

**Placeholder scan:** No TBD/TODO. One conditional instruction remains in Task 6 Step 3 and Task 7 Step 1 ("if typed X, change to Y" / "confirm `spawnHarness` signature") — these are deliberate verify-then-edit guards against unknown local type annotations, each with a concrete fallback, not deferred work.

**Type consistency:**
- `SessionKind` (Task 2) used by `linkChild` (Task 2) and orchestrator calls (Task 4) — consistent literals `"rotation"`/`"subagent"`/`"conversation"`.
- `ResumeEntry extends SessionInfo { resumeId }` (Task 3) — produced by `queryResumeList`/`listRecentSessions` (Task 3), consumed by picker prop + resume handler (Task 6). `resumeId` field name consistent across all three.
- `queryResumeList(db, workspaceId, limit)` signature identical in Task 3 definition, Task 3 tests, and `listRecentSessions` wrapper.
- `fallbackTitle` exported + returns `string` (possibly `""`) — consistent with `generateTitle`'s truthy-guard persist at `orchestrator.ts:755`.
