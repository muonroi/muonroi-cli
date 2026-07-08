import { describe, expect, it } from "vitest";
import type { CouncilStatusData } from "../../../types/index.js";
import { upsertStatus } from "../council-status-list.js";

const base: CouncilStatusData = {
  statusId: "s1",
  state: "tick",
  phase: "exchange",
  label: "Primary Analyst",
  elapsedMs: 2000,
};

describe("upsertStatus startedAt stamping", () => {
  it("stamps startedAt on first insert, back-dated by emitted elapsedMs", () => {
    const before = Date.now();
    const out = upsertStatus([], base);
    const after = Date.now();
    expect(out[0].startedAt).toBeGreaterThanOrEqual(before - 2000);
    expect(out[0].startedAt).toBeLessThanOrEqual(after - 2000);
  });

  it("preserves the original startedAt across updates", () => {
    const first = upsertStatus([], base);
    const stamped = first[0].startedAt;
    const second = upsertStatus(first, { ...base, elapsedMs: 5000, detail: "still going" });
    expect(second[0].startedAt).toBe(stamped);
  });

  it("keeps an emitter-provided startedAt untouched", () => {
    const out = upsertStatus([], { ...base, startedAt: 12345 });
    expect(out[0].startedAt).toBe(12345);
  });
});
