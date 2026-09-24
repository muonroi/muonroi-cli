/**
 * export-transcripts.test.ts
 *
 * Unit tests for exportTranscripts() — SQLite → JSONL transcript export.
 *
 * Strategy: redirect USERPROFILE (Windows) / HOME (POSIX) to a temp dir,
 * create a real SQLite DB at `~/.muonroi-cli/muonroi.db`, and call the
 * function.  Also creates `~/.experience/config.json` so the emit sidecar
 * (transcript-emit) does not gate-return null.
 *
 * Two things this file has to get right, both learned the hard way:
 *
 *  1. Set BOTH `HOME` and `USERPROFILE`. `getDatabasePath()` reads
 *     `HOME ?? USERPROFILE ?? os.homedir()` (src/storage/db.ts:29), so setting
 *     only `USERPROFILE` happens to work in PowerShell (where HOME is unset) and
 *     silently targets the developer's REAL `~/.muonroi-cli/muonroi.db` anywhere
 *     HOME is set — Git Bash, WSL, every Linux CI runner.
 *  2. Call `closeDatabase()` around every test. `getDatabase()` memoizes one
 *     process-wide connection (db.ts:21) and resolves the path only on the first
 *     call, so without the reset every test after the first reads test 1's DB.
 *     This is the same convention as src/storage/__tests__/transcript-fts.test.ts.
 */

// @ts-expect-error — bun:test is provided by the bun runtime; this file runs via
// `bun test`, not vitest, and is excluded from vitest in vitest.config.ts.
//
// It stays a Bun-runtime file on purpose, and the reason is stronger than an
// import that vitest cannot resolve: `getDatabase()` picks its driver from
// `typeof Bun` (src/storage/db.ts:43). Under `bun test` — and under the shipped
// `bun run` — that is `BunSqliteDatabase` (db.ts:94); a vitest worker is Node
// (measured: `process.version` v24.18.0, `typeof Bun === "undefined"`) and gets
// `BetterSqlite3Database` (db.ts:140) instead. The two adapters bind parameters
// differently (`normalizeBinding` vs `spreadBinding`, db.ts:176-185), so running
// this file here is what exercises the adapter users actually ship on.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestEffortRemoveSync } from "../../__test-stubs__/cleanup";
import { closeDatabase } from "../../storage/db.js";

const WORKSPACE_ID = "ws-export-transcripts-test";

let tmpHome = "";
let origUserProfile: string | undefined;
let origHome: string | undefined;

function cleanDb() {
  if (tmpHome) {
    bestEffortRemoveSync(tmpHome, "src/ee/__tests__/export-transcripts.test.ts");
  }
}

/**
 * Seed the REAL schema through `getDatabase()` rather than hand-rolling tables.
 *
 * This used to `new Database(dbPath)` and `CREATE TABLE IF NOT EXISTS sessions
 * (id, updated_at, cwd_last)` itself. Those three columns are not the shipped
 * `sessions` table (src/storage/migrations.ts:190-204: STRICT, eight NOT NULL
 * columns, an FK to `workspaces`), so the file on disk then made
 * `applyMigrations` → `createInitialSchema` fail with
 * `SQLiteError: no such column: workspace_id` the moment production code opened
 * it. Seeding via `getDatabase()` means the fixture can only ever express rows
 * production could actually have written — which is why `cwdLast` is a string
 * here: `cwd_last` is `TEXT NOT NULL` (migrations.ts:200).
 *
 * Messages are described as `{ seq, role, content }` and this function builds
 * `message_json` as `JSON.stringify({ role, content })`, matching
 * `appendMessages` (src/storage/transcript.ts:368: it stores the whole
 * `ModelMessage`). The fixtures used to stringify `{ content }` with no `role`,
 * which no production write ever produces — and `toJsonlEntry`
 * (src/ee/transcript-emit.ts:122-123) drops any message whose parsed `role` is
 * not user/assistant/tool/system, so the wet-run path emitted nothing and
 * `written` could never reach 1. Pass `rawJson` to write a byte-exact value
 * instead (the malformed-JSON case).
 */
async function bootstrapDb(
  sessions: Array<{
    sessionId: string;
    updatedAt: string;
    cwdLast: string;
    messages: Array<{ seq: number; role: string; content?: unknown; rawJson?: string }>;
  }>,
) {
  const { getDatabase } = await import("../../storage/db.js");
  const db = getDatabase();
  const now = new Date().toISOString();
  // `foreign_keys = ON` (db.ts:71) — the workspace row has to exist first.
  db.prepare(
    "INSERT INTO workspaces (id, scope_key, canonical_path, git_root, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, `scope-${WORKSPACE_ID}`, tmpHome, null, "test-workspace", now);
  for (const s of sessions) {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(s.sessionId, WORKSPACE_ID, "test-model", "chat", s.cwdLast, s.cwdLast, "idle", s.updatedAt, s.updatedAt);
    for (const m of s.messages) {
      const messageJson = m.rawJson ?? JSON.stringify({ role: m.role, content: m.content });
      db.prepare("INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
        s.sessionId,
        m.seq,
        m.role,
        messageJson,
        s.updatedAt,
      );
    }
  }
}

beforeEach(() => {
  // Drop any connection a previous test left memoized so this test's HOME wins.
  closeDatabase();
  tmpHome = mkdtempSync(join(tmpdir(), "muonroi-test-export-"));
  const muonroiDir = join(tmpHome, ".muonroi-cli");
  const experienceDir = join(tmpHome, ".experience");
  mkdirSync(muonroiDir, { recursive: true });
  mkdirSync(experienceDir, { recursive: true });
  // Create a minimal config so transcript-emit's isEnabled() returns true.
  writeFileSync(join(experienceDir, "config.json"), JSON.stringify({}), "utf-8");
  origUserProfile = process.env.USERPROFILE;
  origHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  // Close BEFORE removing the temp dir — an open WAL keeps the files locked on
  // Windows, which would turn cleanup into a silent leak.
  closeDatabase();
  cleanDb();
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
});

// ── tests ────────────────────────────────────────────────────────────

describe("exportTranscripts", () => {
  it("no DB file → creates an empty DB and reports nothing to export", async () => {
    // No bootstrapDb call — the DB file does not exist.
    //
    // This used to assert `.rejects.toThrow()`, which is not the contract:
    // `getDatabase()` is create-on-demand by design — it mkdirs
    // `~/.muonroi-cli` (db.ts:31), opens the file with `{ create: true }`
    // (db.ts:99) and runs `applyMigrations` (db.ts:74). ~50 call sites depend on
    // that, so a missing file is an EMPTY history, not an error. The exporter
    // resolving with zeroed counts is correct; the old expectation was wrong.
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: true });
    expect(res.totalSessions).toBe(0);
    expect(res.written).toBe(0);
  });

  it("leaves the shared DB handle usable — two calls in one process both work", async () => {
    // Regression guard for the real defect this file's cascade exposed:
    // `exportTranscripts` used to end in `finally { db.close() }`, closing the
    // process-wide connection `getDatabase()` memoizes without clearing the memo
    // (db.ts:21). The second call then died with
    // `RangeError: Cannot use a closed database` from db.ts:110.
    await bootstrapDb([]);
    const mod = await import("../export-transcripts.js");
    const first = await mod.exportTranscripts({ dryRun: true });
    const second = await mod.exportTranscripts({ dryRun: true });
    expect(first.totalSessions).toBe(0);
    expect(second.totalSessions).toBe(0);
    // And the handle every other module borrows is still alive.
    const { getDatabase } = await import("../../storage/db.js");
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM sessions").all()).toEqual([{ n: 0 }]);
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
        cwdLast: tmpHome,
        messages: [
          { seq: 1, role: "user", content: "hi" },
          { seq: 2, role: "assistant", content: "there" },
          { seq: 3, role: "user", content: "again" },
          { seq: 4, role: "assistant", content: "bye" },
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
        cwdLast: tmpHome,
        messages: [
          { seq: 1, role: "user", content: "hi" },
          { seq: 2, role: "assistant", content: "there" },
          { seq: 3, role: "user", content: "again" },
          { seq: 4, role: "assistant", content: "bye" },
        ],
      },
    ]);
    const mod = await import("../export-transcripts.js");
    const res = await mod.exportTranscripts({ dryRun: false });
    expect(res.totalSessions).toBe(1);
    expect(res.written).toBe(1);
    expect(res.skippedEmpty).toBe(0);
    expect(res.skippedTooSmall).toBe(0);
    // Assert the FILE, not just the counter. `written` is incremented from a
    // truthy `emitTranscriptToDisk` return, and that function swallows every
    // error (`catch { return null }`, transcript-emit.ts:168) — so a counter on
    // its own cannot distinguish "wrote the JSONL" from "returned null".
    const target = join(res.outputRoot, "sess-1.jsonl");
    expect(existsSync(target)).toBe(true);
    const lines = readFileSync(target, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "session_meta", runtime: "muonroi-cli" });
    expect(lines).toHaveLength(5); // 1 session_meta + 4 messages
  });

  it("skips sessions past maxAgeDays", async () => {
    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    await bootstrapDb([
      {
        sessionId: "sess-old",
        updatedAt: old,
        cwdLast: tmpHome,
        messages: [
          { seq: 1, role: "user", content: "old1" },
          { seq: 2, role: "assistant", content: "old resp1" },
          { seq: 3, role: "user", content: "old2" },
          { seq: 4, role: "assistant", content: "old resp2" },
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
        cwdLast: tmpHome,
        messages: [{ seq: 1, role: "user", content: "only" }],
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
        cwdLast: tmpHome,
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
        cwdLast: tmpHome,
        messages: [{ seq: 1, role: "user", rawJson: "NOT_VALID_JSON" }],
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
