import { describe, expect, it } from "vitest";
import { computeBubbleLayout } from "../../ui/components/bubble-layout.js";

describe("computeBubbleLayout", () => {
  it("uses fallback mode when cols < 70", () => {
    const layout = computeBubbleLayout(60);
    expect(layout.fallback).toBe(true);
  });

  it("cols=70 is exactly at the threshold — no fallback", () => {
    const layout = computeBubbleLayout(70);
    expect(layout.fallback).toBe(false);
  });

  it("cols=80 — bubbleCols ≤ 100 and = floor(65% of 80)", () => {
    const layout = computeBubbleLayout(80);
    expect(layout.fallback).toBe(false);
    expect(layout.bubbleCols).toBe(Math.min(Math.floor(80 * 0.65), 100));
    expect(layout.leftIndent).toBe(0);
    expect(layout.rightIndent).toBe(Math.floor(80 * 0.12));
  });

  it("cols=100 — bubbleCols = 65, rightIndent = 12", () => {
    const layout = computeBubbleLayout(100);
    expect(layout.bubbleCols).toBe(65);
    expect(layout.rightIndent).toBe(12);
  });

  it("cols=120 — bubbleCols capped at 100 when 65% exceeds 100", () => {
    const layout = computeBubbleLayout(120);
    expect(layout.bubbleCols).toBe(Math.min(Math.floor(120 * 0.65), 100));
    expect(layout.rightIndent).toBe(Math.floor(120 * 0.12));
  });

  it("cols=160 — bubbleCols capped at 100 (65% = 104 > 100)", () => {
    const layout = computeBubbleLayout(160);
    expect(layout.bubbleCols).toBe(100);
    expect(layout.rightIndent).toBe(Math.floor(160 * 0.12));
  });

  it("leaderCols = 40% of terminal width", () => {
    const layout = computeBubbleLayout(100);
    expect(layout.leaderCols).toBe(40);
  });
});
