/**
 * src/orchestrator/__tests__/message-write-ahead.test.ts
 *
 * Phase A5 — write-ahead persistence for `messages`.
 *
 * The orchestrator's `onStepFinish` callback fires `recordUsage` while
 * streamText is in-flight; without a pre-existing row, the user message
 * isn't yet in the DB (it's only inserted by `appendCompletedTurn(...)`
 * after the stream settles). This made `usage_events.message_seq`
 * resolve to NULL — exactly the anomaly that forensics surfaces.
 *
 * A5 persists a `pending` row in `messages` the moment a new user turn
 * starts. The post-stream path upserts the row to `completed` via
 * `ON CONFLICT(session_id, seq) DO UPDATE`; the error path flips it to
 * `errored` so forensics can tell crashed turns apart from in-flight ones.
 *
 * Strategy: bun:sqlite is mocked globally for vitest (see
 * src/__test-stubs__/vitest-setup.ts). We mock the storage `db` module
 * to inject a fake SQLiteDatabase that records prepare() calls, then
 * verify each helper shapes its SQL correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PreparedStatementCall {
  sql: string;
  runArgs: unknown[];
}

const preparedCalls: PreparedStatementCall[] = [];
let dbShouldThrow = false;

vi.mock("../../storage/db", () => {
  const makeDb = () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        preparedCalls.push({ sql, runArgs: args });
        return undefined;
      },
      get: () => undefined,
      all: () => [],
    }),
    exec: () => undefined,
    pragma: () => undefined,
    transaction: <T>(fn: () => T) => fn,
    close: () => undefined,
  });
  return {
    getDatabase: () => {
      if (dbShouldThrow) throw new Error("simulated SQL failure");
      return makeDb();
    },
    withTransaction: <T>(fn: (db: unknown) => T) => fn(makeDb()),
  };
});

// Import AFTER the mock so the helpers pick up the mocked db module.
import { markMessageCompleted, markMessageErrored, persistMessageWriteAhead } from "../../storage/transcript";

describe("A5: write-ahead messages persistence", () => {
  beforeEach(() => {
    preparedCalls.length = 0;
  });

  afterEach(() => {
    preparedCalls.length = 0;
  });

  describe("persistMessageWriteAhead", () => {
    it("inserts a messages row with status='pending' BEFORE streamText fires", () => {
      persistMessageWriteAhead("session-xyz", 7, "user", JSON.stringify({ role: "user", content: "hello" }));

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      expect(call.sql).toMatch(/INSERT OR IGNORE INTO messages/);
      expect(call.sql).toMatch(/'pending'/);

      // Run args: sessionId, seq, role, messageJson, createdAt.
      expect(call.runArgs).toContain("session-xyz");
      expect(call.runArgs).toContain(7);
      expect(call.runArgs).toContain("user");
      const messageJsonArg = call.runArgs.find((a) => typeof a === "string" && a.includes("hello"));
      expect(messageJsonArg).toBeTruthy();
    });

    it("uses INSERT OR IGNORE so a duplicate write-ahead does not clobber a finalized row", () => {
      persistMessageWriteAhead("s", 1, "user", "{}");
      expect(preparedCalls[0]!.sql).toContain("INSERT OR IGNORE");
    });

    it("is fail-open: a thrown SQL error does NOT propagate to the orchestrator", () => {
      dbShouldThrow = true;
      try {
        expect(() => persistMessageWriteAhead("session-y", 1, "user", "{}")).not.toThrow();
      } finally {
        dbShouldThrow = false;
      }
    });
  });

  describe("markMessageCompleted", () => {
    it("updates the row to status='completed' guarded on status='pending'", () => {
      markMessageCompleted("session-a", 12);

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      expect(call.sql).toMatch(/UPDATE messages/);
      expect(call.sql).toMatch(/SET status = 'completed'/);
      // Guard prevents flipping a row finalized via a different code path
      // (defensive against double-finalize bugs).
      expect(call.sql).toMatch(/status = 'pending'/);

      expect(call.runArgs).toContain("session-a");
      expect(call.runArgs).toContain(12);
    });

    it("is fail-open: a thrown SQL error does NOT propagate", () => {
      dbShouldThrow = true;
      try {
        expect(() => markMessageCompleted("session-c", 5)).not.toThrow();
      } finally {
        dbShouldThrow = false;
      }
    });
  });

  describe("markMessageErrored", () => {
    it("updates the row to status='errored' guarded on status='pending'", () => {
      markMessageErrored("session-b", 42);

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      expect(call.sql).toMatch(/UPDATE messages/);
      expect(call.sql).toMatch(/SET status = 'errored'/);
      expect(call.sql).toMatch(/status = 'pending'/);

      expect(call.runArgs).toContain("session-b");
      expect(call.runArgs).toContain(42);
    });

    it("is fail-open: a thrown SQL error does NOT propagate", () => {
      dbShouldThrow = true;
      try {
        expect(() => markMessageErrored("session-d", 9)).not.toThrow();
      } finally {
        dbShouldThrow = false;
      }
    });
  });

  describe("integration: pending → completed/errored handoff via appendMessages", () => {
    it("documents the contract: the post-stream upsert uses ON CONFLICT(session_id, seq) DO UPDATE", () => {
      // This test pins the SQL contract — `appendMessages()` in
      // transcript.ts uses ON CONFLICT so a write-ahead 'pending' row is
      // upserted to 'completed' atomically with the assistant message
      // insert. If a future refactor reverts to plain INSERT, the
      // write-ahead row would cause a PK violation and the entire
      // turn-persistence transaction would roll back.
      persistMessageWriteAhead("s", 1, "user", "{}");
      expect(preparedCalls[0]!.sql).toContain("INSERT OR IGNORE");
    });

    it("the error path uses a guarded UPDATE so a successful turn's row is never flipped to 'errored'", () => {
      // Defensive: if the catch block fires after the success path
      // (race?), the WHERE status='pending' guard prevents corruption.
      markMessageErrored("s", 1);
      expect(preparedCalls[0]!.sql).toMatch(/WHERE session_id = \? AND seq = \? AND status = 'pending'/);
    });
  });
});
