/**
 * src/storage/__tests__/sweep-stale-pending.test.ts
 *
 * Verifies sweepStalePendingRows shapes its SQL correctly and threads the
 * staleness cutoff through to both UPDATE statements. bun:sqlite is mocked
 * globally for vitest (see src/__test-stubs__/vitest-setup.ts); we capture
 * every prepare() + run() to assert SQL + bound params without standing up
 * a real DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PreparedCall {
  sql: string;
  runArgs: unknown[];
}

const preparedCalls: PreparedCall[] = [];
let dbShouldThrow = false;
let toolCallsChanges = 0;
let messagesChanges = 0;

vi.mock("../db", () => {
  const makeDb = () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        preparedCalls.push({ sql, runArgs: args });
        const lower = sql.toLowerCase();
        if (lower.includes("update tool_calls")) {
          return { changes: toolCallsChanges };
        }
        if (lower.includes("update messages")) {
          return { changes: messagesChanges };
        }
        return { changes: 0 };
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
  };
});

import { sweepStalePendingRows } from "../transcript";

describe("sweepStalePendingRows", () => {
  beforeEach(() => {
    preparedCalls.length = 0;
    dbShouldThrow = false;
    toolCallsChanges = 0;
    messagesChanges = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits two UPDATE statements — one per pending-row class", () => {
    sweepStalePendingRows();
    const sqls = preparedCalls.map((c) => c.sql.toLowerCase());
    expect(sqls.some((s) => s.includes("update tool_calls") && s.includes("status = 'aborted'"))).toBe(true);
    expect(sqls.some((s) => s.includes("update messages") && s.includes("status = 'aborted'"))).toBe(true);
  });

  it("scopes tool_calls update to status='pending' and stale started_at", () => {
    sweepStalePendingRows(1000);
    const toolCallSql = preparedCalls.find((c) => c.sql.toLowerCase().includes("update tool_calls"))?.sql.toLowerCase();
    expect(toolCallSql).toContain("status = 'pending'");
    expect(toolCallSql).toContain("started_at <");
  });

  it("scopes messages update to status='pending' and stale created_at", () => {
    sweepStalePendingRows(1000);
    const messagesSql = preparedCalls.find((c) => c.sql.toLowerCase().includes("update messages"))?.sql.toLowerCase();
    expect(messagesSql).toContain("status = 'pending'");
    expect(messagesSql).toContain("created_at <");
  });

  it("returns the changed-row counts surfaced by SQLite", () => {
    toolCallsChanges = 3;
    messagesChanges = 1;
    const result = sweepStalePendingRows();
    expect(result).toEqual({ toolCalls: 3, messages: 1 });
  });

  it("returns zeroed counts on DB exception (fail-open)", () => {
    dbShouldThrow = true;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = sweepStalePendingRows();
    expect(result).toEqual({ toolCalls: 0, messages: 0 });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("sweepStalePendingRows failed"));
  });

  it("computes the cutoff timestamp as Date.now() - staleAfterMs", () => {
    const fixedNow = new Date("2026-05-22T10:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    sweepStalePendingRows(60_000);
    const toolCallCall = preparedCalls.find((c) => c.sql.toLowerCase().includes("update tool_calls"));
    // run args: [cutoff]
    const cutoff = toolCallCall?.runArgs[0] as string;
    expect(cutoff).toBe("2026-05-22T09:59:00.000Z");
  });
});
