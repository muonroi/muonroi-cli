/**
 * src/orchestrator/__tests__/usage-events-shape.test.ts
 *
 * Phase O1 — integration check that `recordUsageEvent` threads
 * `providerOptionsShape` through to the INSERT statement on `usage_events`.
 * Mirrors the mock-db pattern from write-ahead.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PreparedStatementCall {
  sql: string;
  runArgs: unknown[];
}

const preparedCalls: PreparedStatementCall[] = [];

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
    getDatabase: () => makeDb(),
    withTransaction: <T>(fn: (db: unknown) => T) => fn(makeDb()),
  };
});

// Import AFTER the mock so usage.ts picks up the mocked db.
import { recordUsageEvent } from "../../storage/usage";

describe("O1: usage_events INSERT carries provider_options_shape", () => {
  beforeEach(() => {
    preparedCalls.length = 0;
  });
  afterEach(() => {
    preparedCalls.length = 0;
  });

  it("includes provider_options_shape column in INSERT and passes shape JSON as the trailing param", () => {
    const shape = JSON.stringify({ openai: { store: "boolean", promptCacheKey: "string" } });
    recordUsageEvent(
      "sess-1",
      "message",
      "gpt-5.4",
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      7,
      false,
      0,
      shape,
    );

    expect(preparedCalls).toHaveLength(1);
    const call = preparedCalls[0]!;
    expect(call.sql).toMatch(/INSERT INTO usage_events/);
    expect(call.sql).toMatch(/provider_options_shape/);
    // 14 columns now: 13 prior + provider_options_shape. The shape value
    // should be the LAST runArg.
    expect(call.runArgs).toHaveLength(14);
    expect(call.runArgs[call.runArgs.length - 1]).toBe(shape);
  });

  it("defaults provider_options_shape to null when caller omits it (backwards compat)", () => {
    recordUsageEvent("sess-2", "title", "gpt-5.4", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, null);

    expect(preparedCalls).toHaveLength(1);
    const call = preparedCalls[0]!;
    expect(call.runArgs[call.runArgs.length - 1]).toBeNull();
  });
});
