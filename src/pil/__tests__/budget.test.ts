import { describe, expect, it } from "vitest";
import { truncateToBudget, DEFAULT_TOKEN_BUDGET } from "../budget";

describe("truncateToBudget", () => {
  it("allows ~4 chars per token of budget", () => {
    const text = "a".repeat(400);
    const result = truncateToBudget(text, 100);
    expect(result).toBe(text);
  });

  it("truncates text exceeding budget in token-equivalent chars", () => {
    const text = "a".repeat(500);
    const result = truncateToBudget(text, 100);
    expect(result.length).toBeLessThanOrEqual(404);
  });

  it("returns short text unchanged", () => {
    expect(truncateToBudget("hello world", 100)).toBe("hello world");
  });

  it("truncates at word boundary when possible", () => {
    const text = "word ".repeat(120);
    const result = truncateToBudget(text, 100);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(404);
  });

  it("handles empty string", () => {
    expect(truncateToBudget("", 100)).toBe("");
  });

  it("handles budget=0 by truncating everything", () => {
    expect(truncateToBudget("hello", 0)).toBe("...");
  });

  it("DEFAULT_TOKEN_BUDGET is 500", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(500);
  });
});
