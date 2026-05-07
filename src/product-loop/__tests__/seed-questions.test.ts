import { describe, expect, it } from "vitest";
import { SEED_DIMENSIONS } from "../seed-questions.js";

describe("SEED_DIMENSIONS", () => {
  it("has exactly 6 dimensions", () => {
    expect(SEED_DIMENSIONS.length).toBe(6);
  });

  it("has all required IDs in order", () => {
    const ids = SEED_DIMENSIONS.map(d => d.id);
    expect(ids).toEqual([
      "persona",
      "core-features",
      "non-functional",
      "tech-constraints",
      "success-metric",
      "cost-tolerance"
    ]);
  });

  it("has required flag set to true for all", () => {
    SEED_DIMENSIONS.forEach(d => {
      expect(d.isRequired).toBe(true);
    });
  });

  it("has non-empty question text ending with ?", () => {
    SEED_DIMENSIONS.forEach(d => {
      expect(d.question).toMatch(/\?$/);
      expect(d.question.length).toBeGreaterThan(10);
    });
  });
});
