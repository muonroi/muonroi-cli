import { describe, expect, it } from "vitest";
import { compactBar, fmtCompactElapsed } from "../compact-progress-card.js";

describe("fmtCompactElapsed", () => {
  it("shows seconds under a minute", () => {
    expect(fmtCompactElapsed(42_000)).toBe("42s");
    expect(fmtCompactElapsed(0)).toBe("0s");
  });

  it("shows minutes and seconds past a minute", () => {
    expect(fmtCompactElapsed(79_000)).toBe("1m 19s");
    expect(fmtCompactElapsed(600_000)).toBe("10m 0s");
  });

  // Clock skew between startedAt and now must not print "-1s".
  it("floors at zero", () => {
    expect(fmtCompactElapsed(-5_000)).toBe("0s");
  });
});

describe("compactBar", () => {
  it("is exactly `width` cells at every percent, so the line never reflows", () => {
    for (const pct of [0, 1, 33, 58, 99, 100]) {
      expect(compactBar(pct, 20)).toHaveLength(20);
    }
  });

  it("fills proportionally", () => {
    expect(compactBar(0, 10)).toBe("░░░░░░░░░░");
    expect(compactBar(50, 10)).toBe("█████░░░░░");
    expect(compactBar(100, 10)).toBe("██████████");
  });

  it("clamps out-of-range and non-finite input instead of throwing on repeat()", () => {
    expect(compactBar(140, 10)).toBe("██████████");
    expect(compactBar(-20, 10)).toBe("░░░░░░░░░░");
    expect(compactBar(Number.NaN, 10)).toBe("░░░░░░░░░░");
  });
});
