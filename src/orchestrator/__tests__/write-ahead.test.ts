/**
 * src/orchestrator/__tests__/write-ahead.test.ts
 *
 * Phase A4 — write-ahead persistence for tool_calls.
 *
 * The orchestrator's streamText loop now persists a `pending` row in
 * `tool_calls` the moment the model emits a `tool-call` part — BEFORE
 * the tool executes. If the stream throws between this point and
 * `appendCompletedTurn(...)`, the row remains as `pending`, giving
 * `usage forensics <prefix>` a recoverable trail of what input the model
 * passed (previously this row would never have been written → silent
 * cost-leak forensic gap).
 *
 * Strategy: bun:sqlite is mocked globally for vitest (see
 * src/__test-stubs__/vitest-setup.ts). We mock the storage `db` module to
 * inject a fake SQLiteDatabase that records prepare() calls, then verify
 * `persistToolCallWriteAhead` and `markToolCallErrored` shape their SQL
 * correctly.
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

// Import AFTER the mock so the helper picks up the mocked db module.
import { markToolCallErrored, persistToolCallWriteAhead } from "../../storage/transcript";

describe("A4: write-ahead tool_calls persistence", () => {
  beforeEach(() => {
    preparedCalls.length = 0;
  });

  afterEach(() => {
    preparedCalls.length = 0;
  });

  describe("persistToolCallWriteAhead", () => {
    it("inserts a tool_calls row with status='pending' BEFORE tool execution", () => {
      persistToolCallWriteAhead(
        "session-xyz",
        42,
        "tool-call-abc",
        "read_file",
        JSON.stringify({ path: "/etc/hosts" }),
      );

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      expect(call.sql).toMatch(/INSERT OR IGNORE INTO tool_calls/);
      expect(call.sql).toMatch(/'pending'/);
      // started_at populated, completed_at NULL.
      expect(call.sql).toMatch(/completed_at/);
      expect(call.sql).toMatch(/NULL/);

      // Run args: sessionId, messageSeq, toolCallId, toolName, argsJson, timestamp
      expect(call.runArgs).toContain("session-xyz");
      expect(call.runArgs).toContain(42);
      expect(call.runArgs).toContain("tool-call-abc");
      expect(call.runArgs).toContain("read_file");
      const argsJsonArg = call.runArgs.find((a) => typeof a === "string" && a.includes("/etc/hosts"));
      expect(argsJsonArg).toBeTruthy();
    });

    it("is fail-open: a thrown SQL error does NOT propagate to the orchestrator", () => {
      dbShouldThrow = true;
      try {
        expect(() => persistToolCallWriteAhead("session-y", 1, "tc-1", "bash", "{}")).not.toThrow();
      } finally {
        dbShouldThrow = false;
      }
    });

    it("accepts -1 as a sentinel message_seq when prediction is unavailable", () => {
      persistToolCallWriteAhead("session-zzz", -1, "tc-2", "grep", "{}");

      expect(preparedCalls).toHaveLength(1);
      expect(preparedCalls[0]!.runArgs).toContain(-1);
    });
  });

  describe("markToolCallErrored", () => {
    it("updates the row to status='errored' with a completed_at timestamp", () => {
      markToolCallErrored("session-a", "tc-99", "tool execution threw");

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      expect(call.sql).toMatch(/UPDATE tool_calls/);
      expect(call.sql).toMatch(/SET status = 'errored'/);
      expect(call.sql).toMatch(/completed_at = \?/);

      expect(call.runArgs).toContain("session-a");
      expect(call.runArgs).toContain("tc-99");
    });

    it("truncates extreme error messages to 500 chars in the fallback args_json", () => {
      const huge = "x".repeat(2_000);
      markToolCallErrored("session-b", "tc-100", huge);

      expect(preparedCalls).toHaveLength(1);
      const call = preparedCalls[0]!;
      const fallbackArgsJson = call.runArgs.find((a) => typeof a === "string" && a.startsWith('{"error":')) as
        | string
        | undefined;
      expect(fallbackArgsJson).toBeDefined();
      // Parsed shape: {"error":"xxx...xxx"} — payload <= 500 chars + JSON overhead.
      expect(fallbackArgsJson!.length).toBeLessThan(600);
    });

    it("is fail-open: a thrown SQL error does NOT propagate", () => {
      dbShouldThrow = true;
      try {
        expect(() => markToolCallErrored("session-c", "tc-200", "boom")).not.toThrow();
      } finally {
        dbShouldThrow = false;
      }
    });
  });

  describe("integration: pending → completed handoff via appendMessages", () => {
    it("documents the contract: write-ahead uses INSERT OR IGNORE so post-stream UPDATE finalizes the same row", () => {
      // This test pins the SQL contract — appendMessages() in transcript.ts
      // uses the same (session_id, tool_call_id) UNIQUE constraint to UPDATE
      // the pending row to status='completed' after the turn settles.
      //
      // If a future refactor switches write-ahead to plain INSERT, the
      // post-stream path would hit a UNIQUE constraint violation and the
      // whole turn-persistence transaction would roll back.
      persistToolCallWriteAhead("s", 1, "tc-shared", "bash", "{}");
      expect(preparedCalls[0]!.sql).toContain("INSERT OR IGNORE");
    });
  });
});
