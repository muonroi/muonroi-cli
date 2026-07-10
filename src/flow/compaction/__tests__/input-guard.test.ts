import { describe, expect, it } from "vitest";
import { capCompactionInput } from "../input-guard.js";

describe("capCompactionInput", () => {
  it("returns short text unchanged (fits the floor)", () => {
    const text = "small conversation";
    expect(capCompactionInput(text, 200_000)).toBe(text);
  });

  it("returns text unchanged when it fits the window budget", () => {
    // window 100k tokens → budget = 100_000 * 4 * 0.55 = 220_000 chars.
    const text = "x".repeat(100_000);
    expect(capCompactionInput(text, 100_000)).toBe(text);
  });

  it("keeps head + tail and elides the middle when over budget", () => {
    // window 10k tokens → budget = 10_000 * 4 * 0.55 = 22_000 chars.
    const head = "H".repeat(20_000);
    const tail = "T".repeat(20_000);
    const mid = "M".repeat(20_000);
    const out = capCompactionInput(head + mid + tail, 10_000);
    expect(out.length).toBeLessThan(head.length + mid.length + tail.length);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("characters of the middle");
    // The all-M middle must be gone (elided).
    expect(out).not.toContain("M".repeat(1_000));
  });

  it("uses the absolute floor (24k) when the window is unknown (0)", () => {
    const text = "z".repeat(50_000);
    const out = capCompactionInput(text, 0);
    // Floor 24k → text (50k) exceeds it → gets capped.
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("characters of the middle");
  });

  it("leaves an unknown-window text under the floor unchanged", () => {
    const text = "z".repeat(10_000);
    expect(capCompactionInput(text, 0)).toBe(text);
  });
});
