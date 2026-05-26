/**
 * src/reporter/__tests__/budget.test.ts
 *
 * Tests for LLM daily budget tracking.
 * Uses a temp directory so no actual .planning files are written.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReporterDailySpend, recordReporterSpend } from "../budget.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reporter-budget-test-"));
  // Create the expected directory structure
  await fs.mkdir(path.join(tmpDir, "runs", "run-test"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("getReporterDailySpend", () => {
  it("returns 0 when no budget file exists", async () => {
    const spend = await getReporterDailySpend(tmpDir, "run-test");
    expect(spend).toBe(0);
  });
});

describe("recordReporterSpend + getReporterDailySpend", () => {
  it("accumulates spend for today", async () => {
    await recordReporterSpend(tmpDir, "run-test", 0.05);
    const spend = await getReporterDailySpend(tmpDir, "run-test");
    expect(spend).toBeCloseTo(0.05);

    await recordReporterSpend(tmpDir, "run-test", 0.03);
    const spend2 = await getReporterDailySpend(tmpDir, "run-test");
    expect(spend2).toBeCloseTo(0.08);
  });

  it("tracks different UTC days separately", async () => {
    const TODAY = "2026-01-15";
    const YESTERDAY = "2026-01-14";

    const origDate = globalThis.Date;

    // Record spend "yesterday"
    globalThis.Date = class extends origDate {
      toISOString(): string {
        return `${YESTERDAY}T12:00:00.000Z`;
      }
    } as unknown as typeof Date;

    await recordReporterSpend(tmpDir, "run-test", 0.1);

    // Record spend "today"
    globalThis.Date = class extends origDate {
      toISOString(): string {
        return `${TODAY}T08:00:00.000Z`;
      }
    } as unknown as typeof Date;

    await recordReporterSpend(tmpDir, "run-test", 0.2);

    const todaySpend = await getReporterDailySpend(tmpDir, "run-test");
    expect(todaySpend).toBeCloseTo(0.2);

    globalThis.Date = origDate;
  });
});
