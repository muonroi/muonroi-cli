import { describe, expect, it } from "vitest";
import { clampTitle } from "../loop-driver.js";

describe("clampTitle (F12 — no dangling punctuation in index titles)", () => {
  it("returns a short title unchanged (sans trailing punctuation)", () => {
    expect(clampTitle("Accept CSV input", 50)).toBe("Accept CSV input");
    expect(clampTitle("Accept CSV input (", 50)).toBe("Accept CSV input");
  });

  it("truncates at a word boundary and strips a dangling open paren", () => {
    const raw = "Accept CSV input via file path or standard input (stdin) mode";
    const out = clampTitle(raw, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("(")).toBe(false);
    expect(out.endsWith(" ")).toBe(false);
    expect(raw.startsWith(out)).toBe(true);
  });

  it("hard-slices a single overlong token with no space", () => {
    const out = clampTitle("x".repeat(80), 50);
    expect(out.length).toBe(50);
  });

  it("trims whitespace and handles empty input", () => {
    expect(clampTitle("   hi  ", 50)).toBe("hi");
    expect(clampTitle("", 50)).toBe("");
  });
});
