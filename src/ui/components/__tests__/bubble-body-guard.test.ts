import { describe, expect, it } from "vitest";
import { capBubbleBody, MAX_BUBBLE_BODY_CHARS } from "../bubble-body-guard.js";

describe("capBubbleBody — total-length cap", () => {
  it("leaves a normal-sized body untouched", () => {
    const body = "We should keep the council engine in-process.\n\nAgreed.";
    expect(capBubbleBody(body, 80)).toBe(body);
  });

  it("caps an over-long body and appends the /export pointer", () => {
    const body = "x".repeat(MAX_BUBBLE_BODY_CHARS + 5_000);
    const out = capBubbleBody(body, 80);
    // Body itself is bounded (plus the hard-wrap newlines + the footer line).
    expect(out.length).toBeLessThan(MAX_BUBBLE_BODY_CHARS + 500);
    expect(out).toContain("truncated — see /export");
  });

  it("respects a custom maxChars", () => {
    const out = capBubbleBody("a".repeat(1000), 80, 100);
    expect(out).toContain("truncated — see /export");
    expect(out.replace(/\n/g, "").length).toBeLessThan(200);
  });
});

describe("capBubbleBody — hard-wrap of whitespace-free runs", () => {
  it("breaks a single mega-token into <=cols segments", () => {
    const out = capBubbleBody("z".repeat(500), 40);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("does not touch prose that already breaks on spaces", () => {
    const body = "the quick brown fox jumps over the lazy dog ".repeat(20).trim();
    expect(capBubbleBody(body, 40)).toBe(body);
  });

  it("guards against a bogus terminalCols (0 / NaN) without a degenerate cadence", () => {
    for (const cols of [0, Number.NaN, -5]) {
      const out = capBubbleBody("q".repeat(300), cols as number);
      // Falls back to an 80-col wrap, never a 1-char-per-line explosion.
      expect(out.split("\n").every((l) => l.length <= 80)).toBe(true);
      expect(out.split("\n").length).toBeLessThan(10);
    }
  });
});

describe("capBubbleBody — scaling (the freeze this guard prevents)", () => {
  it("processes a 200KB mega-line in well under a second (linear, not O(n^2))", () => {
    const megaLine = "a".repeat(200_000);
    const start = performance.now();
    const out = capBubbleBody(megaLine, 100);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(500);
    // Output is bounded by the char cap regardless of input size.
    expect(out.length).toBeLessThan(MAX_BUBBLE_BODY_CHARS + 500);
  });
});
