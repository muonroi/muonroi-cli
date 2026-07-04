import { describe, expect, it } from "vitest";
import { computeCacheHitPct } from "./cache-hit";

describe("computeCacheHitPct", () => {
  it("returns null before any input", () => {
    expect(computeCacheHitPct({ in_tokens: 0, cache_read_tokens: 0 })).toBeNull();
  });
  it("computes the measured DeepSeek ratio (81%)", () => {
    expect(computeCacheHitPct({ in_tokens: 15_842_501, cache_read_tokens: 12_857_984 })).toBe(81);
  });
  it("clamps to 0..100 and rounds", () => {
    expect(computeCacheHitPct({ in_tokens: 100, cache_read_tokens: 0 })).toBe(0);
    expect(computeCacheHitPct({ in_tokens: 100, cache_read_tokens: 999 })).toBe(100);
  });
});
