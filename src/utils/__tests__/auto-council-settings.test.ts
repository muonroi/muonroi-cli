import { describe, expect, it } from "vitest";
import { normalizeAutoCouncilConfidence, normalizeAutoCouncilMinRoles } from "../settings.js";

describe("normalizeAutoCouncilConfidence", () => {
  it("defaults to 0.85 when undefined / wrong type", () => {
    expect(normalizeAutoCouncilConfidence(undefined)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence(null)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence("0.9")).toBe(0.85);
    expect(normalizeAutoCouncilConfidence({})).toBe(0.85);
  });

  it("accepts values inside [0.5, 1.0]", () => {
    expect(normalizeAutoCouncilConfidence(0.5)).toBe(0.5);
    expect(normalizeAutoCouncilConfidence(0.7)).toBe(0.7);
    expect(normalizeAutoCouncilConfidence(0.85)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence(1.0)).toBe(1.0);
  });

  it("clamps to default when out of range", () => {
    expect(normalizeAutoCouncilConfidence(0.49)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence(0)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence(1.01)).toBe(0.85);
    expect(normalizeAutoCouncilConfidence(-1)).toBe(0.85);
  });
});

describe("normalizeAutoCouncilMinRoles", () => {
  it("defaults to 2 when undefined / wrong type", () => {
    expect(normalizeAutoCouncilMinRoles(undefined)).toBe(2);
    expect(normalizeAutoCouncilMinRoles(null)).toBe(2);
    expect(normalizeAutoCouncilMinRoles("2")).toBe(2);
  });

  it("accepts integers in [1, 4]", () => {
    expect(normalizeAutoCouncilMinRoles(1)).toBe(1);
    expect(normalizeAutoCouncilMinRoles(2)).toBe(2);
    expect(normalizeAutoCouncilMinRoles(3)).toBe(3);
    expect(normalizeAutoCouncilMinRoles(4)).toBe(4);
  });

  it("rejects non-integer / out-of-range", () => {
    expect(normalizeAutoCouncilMinRoles(0)).toBe(2);
    expect(normalizeAutoCouncilMinRoles(5)).toBe(2);
    expect(normalizeAutoCouncilMinRoles(2.5)).toBe(2);
  });
});
