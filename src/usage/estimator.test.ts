import { describe, expect, it } from "vitest";
import { estimateTokensFromChars, projectCostUSD } from "./estimator.js";

describe("estimator", () => {
  describe("projectCostUSD", () => {
    it("computes cost for known anthropic model", () => {
      // claude-3-5-sonnet-latest: $3/M input, $15/M output
      // 1M input + 1M output = $3 + $15 = $18
      const cost = projectCostUSD("anthropic", "claude-3-5-sonnet-latest", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(18.0, 4);
    });

    it("returns 0 for unknown model", () => {
      const cost = projectCostUSD("anthropic", "nonexistent-model", 1_000_000, 1_000_000);
      expect(cost).toBe(0);
    });

    it("returns 0 for unknown provider", () => {
      const cost = projectCostUSD("unknown-provider", "gpt-4o", 1_000_000, 1_000_000);
      expect(cost).toBe(0);
    });

    it("ollama wildcard returns 0 cost", () => {
      const cost = projectCostUSD("ollama", "llama3.2", 1_000_000, 1_000_000);
      expect(cost).toBe(0);
    });

    it("computes haiku cost correctly", () => {
      // claude-3-5-haiku-latest: $0.80/M input, $4.00/M output
      // 100k input + 25k output = 0.08 + 0.10 = 0.18
      const cost = projectCostUSD("anthropic", "claude-3-5-haiku-latest", 100_000, 25_000);
      expect(cost).toBeCloseTo(0.18, 4);
    });
  });

  describe("estimateTokensFromChars", () => {
    it("divides chars by 4 and rounds up", () => {
      expect(estimateTokensFromChars(100)).toBe(25);
      expect(estimateTokensFromChars(101)).toBe(26);
      expect(estimateTokensFromChars(0)).toBe(0);
    });
  });
});
