import { describe, it, expect } from "vitest";
import { sparkline } from "../product-status-card.js";

describe("sparkline", () => {
  it("returns empty string for empty array", () => {
    expect(sparkline([])).toBe("");
  });

  it("renders one block per value", () => {
    const out = sparkline([0, 0.25, 0.5, 0.75, 1]);
    expect(out.length).toBe(5);
  });

  it("clamps values outside [0,1]", () => {
    const out = sparkline([-1, 2, 0.5]);
    // out-of-range should not throw and should still produce 3 blocks
    expect(out.length).toBe(3);
    // first (clamped to 0) → lowest block; second (clamped to 1) → highest block
    expect(out.charAt(0)).toBe("▁");
    expect(out.charAt(1)).toBe("█");
  });

  it("produces ascending blocks for ascending values", () => {
    const out = sparkline([0.1, 0.4, 0.9]);
    const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const idxOf = (c: string) => blocks.indexOf(c);
    expect(idxOf(out.charAt(0))).toBeLessThan(idxOf(out.charAt(1)));
    expect(idxOf(out.charAt(1))).toBeLessThan(idxOf(out.charAt(2)));
  });
});
