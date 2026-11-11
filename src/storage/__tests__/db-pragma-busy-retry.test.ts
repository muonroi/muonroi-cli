/**
 * pragmaRetryingBusy: the WAL switch of a fresh DB can return SQLITE_BUSY even
 * with busy_timeout set (ci-matrix windows job 130416565204). BUSY is retried a
 * bounded number of times; any other error, or BUSY past the bound, is thrown.
 */
import { describe, expect, it } from "vitest";
import { pragmaRetryingBusy } from "../db.js";

const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

function fakeDb(failures: Array<() => Error>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    pragma: (_q: string) => {
      const next = failures[calls++];
      if (next) throw next();
      return "wal";
    },
  };
}

describe("pragmaRetryingBusy", () => {
  it("retries SQLITE_BUSY and returns the pragma result", () => {
    const db = fakeDb([busy, busy]);
    const waits: number[] = [];
    expect(pragmaRetryingBusy(db, "journal_mode = WAL", (ms) => waits.push(ms))).toBe("wal");
    expect(db.calls).toBe(3);
    expect(waits).toEqual([50, 100]);
  });

  it("throws a non-BUSY error at once", () => {
    const db = fakeDb([() => new Error("disk I/O error")]);
    expect(() => pragmaRetryingBusy(db, "journal_mode = WAL", () => {})).toThrow("disk I/O error");
    expect(db.calls).toBe(1);
  });

  it("gives up after the bound and rethrows the BUSY error", () => {
    const db = fakeDb(Array.from({ length: 20 }, () => busy));
    expect(() => pragmaRetryingBusy(db, "journal_mode = WAL", () => {})).toThrow("database is locked");
    expect(db.calls).toBe(8);
  });
});
