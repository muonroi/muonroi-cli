import { describe, it, expect } from "vitest";
import { evidenceLooksValid, wrapSynthesisWithEvidence, type Criterion } from "../reality-anchor.js";

describe("evidenceLooksValid", () => {
  it("should accept file:line format", () => {
    expect(evidenceLooksValid("src/sync.ts:42")).toBe(true);
    expect(evidenceLooksValid("app.py:10")).toBe(true);
  });

  it("should accept test/describe format", () => {
    expect(evidenceLooksValid("test('handles empty input')")).toBe(true);
    expect(evidenceLooksValid('describe("auth flow")')).toBe(true);
  });

  it("should accept commit sha (7-40 hex)", () => {
    expect(evidenceLooksValid("abcdef1234567")).toBe(true);
    expect(evidenceLooksValid("1234567890abcdef1234567890abcdef12345678")).toBe(true);
  });

  it("should accept benchmark format", () => {
    expect(evidenceLooksValid("p95: 240ms")).toBe(true);
    expect(evidenceLooksValid("throughput = 5000")).toBe(true);
    expect(evidenceLooksValid("lighthouse 98")).toBe(true);
  });

  it("should accept HTTP test format", () => {
    expect(evidenceLooksValid("GET /api/users → 200")).toBe(true);
    expect(evidenceLooksValid("POST /auth/login → 201")).toBe(true);
  });

  it("should reject free-form prose with no anchors", () => {
    expect(evidenceLooksValid("we wrote some tests and they passed")).toBe(false);
    expect(evidenceLooksValid("I checked the code and it looks good")).toBe(false);
  });

  it("should reject empty string", () => {
    expect(evidenceLooksValid("")).toBe(false);
    expect(evidenceLooksValid("   ")).toBe(false);
  });
});

describe("wrapSynthesisWithEvidence", () => {
  it("should annotate criteria correctly", () => {
    const criteria: Criterion[] = [
      { id: "C1", status: "met", evidence: "src/main.ts:10" },
      { id: "C2", status: "partial", evidence: "invalid evidence" },
      { id: "C3", status: "unmet" },
      { id: "C4", status: "met" } // missing evidence
    ];

    const wrapped = wrapSynthesisWithEvidence(criteria);

    expect(wrapped[0].evidenceValid).toBe(true);
    expect(wrapped[1].evidenceValid).toBe(false);
    expect(wrapped[2].evidenceValid).toBe(true); // unmet is always true-valid
    expect(wrapped[3].evidenceValid).toBe(false);
  });
});
