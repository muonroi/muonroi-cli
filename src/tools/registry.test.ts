import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS, truncateOutput } from "./registry.js";

describe("truncateOutput", () => {
  it("returns input unchanged when under cap", () => {
    const text = "a".repeat(100);
    expect(truncateOutput(text)).toBe(text);
  });

  it("preserves head and tail when over cap", () => {
    const big = "X".repeat(MAX_TOOL_OUTPUT_CHARS + 5_000);
    const out = truncateOutput(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith("X")).toBe(true);
    expect(out.endsWith("X")).toBe(true);
    expect(out).toContain("chars truncated");
    expect(out).toContain("full output in transcript");
  });

  it("honors custom maxChars", () => {
    const big = "Y".repeat(2_000);
    const out = truncateOutput(big, 500);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("chars truncated");
  });

  it("exports a cap within the documented range", () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBeGreaterThanOrEqual(10_000);
    expect(MAX_TOOL_OUTPUT_CHARS).toBeLessThanOrEqual(200_000);
  });

  it("truncation marker accounts for full delta", () => {
    const big = "Z".repeat(100_000);
    const out = truncateOutput(big, 10_000);
    const expectedDelta = 100_000 - 10_000;
    expect(out).toContain(`${expectedDelta} chars truncated`);
  });
});
