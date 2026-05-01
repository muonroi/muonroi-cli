import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJSON } from "./atomic-io.js";
import { loadUsage, saveUsage } from "./usage-cap.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function currentMonthUTC(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

describe("loadUsage", () => {
  it("Test 7: bootstraps usage.json when absent", async () => {
    const state = await loadUsage(tmpDir);
    expect(state.current_month_utc).toBe(currentMonthUTC());
    expect(state.current_usd).toBe(0);
    expect(state.reservations).toEqual([]);

    // File must be written
    const raw = await fs.readFile(path.join(tmpDir, "usage.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.current_usd).toBe(0);
  });

  it("Test 9: auto-resets on stale month", async () => {
    // Write a state with a past month
    await atomicWriteJSON(path.join(tmpDir, "usage.json"), {
      current_month_utc: "2026-03",
      current_usd: 5.5,
      reservations: [],
    });

    const state = await loadUsage(tmpDir);
    expect(state.current_month_utc).toBe(currentMonthUTC());
    expect(state.current_usd).toBe(0);
  });
});

describe("saveUsage", () => {
  it("Test 8: round-trips via loadUsage", async () => {
    const initial = await loadUsage(tmpDir);
    await saveUsage({ ...initial, current_usd: 1.23 }, tmpDir);
    const loaded = await loadUsage(tmpDir);
    expect(loaded.current_usd).toBe(1.23);
  });
});
