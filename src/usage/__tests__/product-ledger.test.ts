import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProductLedger, getProductSpentUsd, readProductLedger } from "../product-ledger.js";

// Module-level variable set fresh in beforeEach so each test gets an isolated directory.
let TEST_HOME: string;

describe("product-ledger", () => {
  beforeEach(async () => {
    TEST_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-ledger-test-"));
  });

  afterEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it("appends and reads entries", async () => {
    const runId = "test-run";
    const entry1 = { ts: 1000, productRunId: runId, reservationId: "r1", actualUsd: 0.1, model: "m1", provider: "p1" };
    const entry2 = { ts: 1001, productRunId: runId, reservationId: "r2", actualUsd: 0.2, model: "m1", provider: "p1" };

    await appendProductLedger(runId, entry1, TEST_HOME);
    await appendProductLedger(runId, entry2, TEST_HOME);

    const entries = await readProductLedger(runId, TEST_HOME);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(entry1);
    expect(entries[1]).toEqual(entry2);
  });

  it("calculates spent USD correctly", async () => {
    const runId = "test-run-spent";
    await appendProductLedger(
      runId,
      { ts: 1, productRunId: runId, reservationId: "r1", actualUsd: 0.1, model: "m", provider: "p" },
      TEST_HOME,
    );
    await appendProductLedger(
      runId,
      { ts: 2, productRunId: runId, reservationId: "r2", actualUsd: 0.2, model: "m", provider: "p" },
      TEST_HOME,
    );

    const spent = await getProductSpentUsd(runId, TEST_HOME);
    expect(spent).toBeCloseTo(0.3);
  });

  it("handles missing files gracefully", async () => {
    const entries = await readProductLedger("non-existent", TEST_HOME);
    expect(entries).toEqual([]);

    const spent = await getProductSpentUsd("non-existent", TEST_HOME);
    expect(spent).toBe(0);
  });

  it("handles concurrent appends", { retry: 2 }, async () => {
    const runId = "concurrent-run";
    const count = 10;
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        appendProductLedger(
          runId,
          {
            ts: Date.now(),
            productRunId: runId,
            reservationId: `r${i}`,
            actualUsd: 0.01,
            model: "m",
            provider: "p",
          },
          TEST_HOME,
        ),
      );
    }

    await Promise.all(promises);

    const entries = await readProductLedger(runId, TEST_HOME);
    expect(entries).toHaveLength(count);
    const spent = await getProductSpentUsd(runId, TEST_HOME);
    expect(spent).toBeCloseTo(count * 0.01);
  });
});
