/**
 * Compaction-model cooldown backs off and recovers instead of parking a model
 * for a flat window after every failure. Session c2fda568be6b: both
 * summarizers sat in "cooling down after a recent failure" for 10-minute
 * windows between attempts from 10:57Z to 11:44Z.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCompactionModelCooldownForTests,
  clearCompactionModelCooldown,
  compactionCooldownForFailures,
  isCompactionModelCoolingDown,
  markCompactionModelCooldown,
} from "../compaction-model-cooldown.js";

beforeEach(() => {
  __resetCompactionModelCooldownForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T11:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("compaction model cooldown", () => {
  it("backs off exponentially from one minute up to the configured maximum", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => compactionCooldownForFailures(n, 600_000))).toEqual([
      60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });

  it("a first failure expires after the base cooldown; a repeat failure waits longer", () => {
    markCompactionModelCooldown("s", "m");
    expect(isCompactionModelCoolingDown("s", "m")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isCompactionModelCoolingDown("s", "m")).toBe(false);
    markCompactionModelCooldown("s", "m");
    vi.advanceTimersByTime(60_000);
    expect(isCompactionModelCoolingDown("s", "m")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isCompactionModelCoolingDown("s", "m")).toBe(false);
  });

  it("a success resets the backoff", () => {
    markCompactionModelCooldown("s", "m");
    markCompactionModelCooldown("s", "m");
    markCompactionModelCooldown("s", "m");
    clearCompactionModelCooldown("s", "m");
    expect(isCompactionModelCoolingDown("s", "m")).toBe(false);
    markCompactionModelCooldown("s", "m");
    vi.advanceTimersByTime(60_000);
    expect(isCompactionModelCoolingDown("s", "m")).toBe(false);
  });

  it("is scoped per session and per model", () => {
    markCompactionModelCooldown("s", "m");
    expect(isCompactionModelCoolingDown("other", "m")).toBe(false);
    expect(isCompactionModelCoolingDown("s", "other")).toBe(false);
  });
});
