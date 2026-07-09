import { afterEach, describe, expect, it } from "vitest";
import {
  isAutoCouncilClarifyEnabled,
  isAutoCouncilSkipReasoning,
  normalizeAutoCouncilConfidence,
  normalizeAutoCouncilMinRoles,
} from "../settings.js";

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

describe("isAutoCouncilClarifyEnabled", () => {
  const prev = process.env.MUONROI_AUTOCOUNCIL_CLARIFY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_AUTOCOUNCIL_CLARIFY;
    else process.env.MUONROI_AUTOCOUNCIL_CLARIFY = prev;
  });

  it("defaults to true — the pre-debate interview runs unless disabled", () => {
    delete process.env.MUONROI_AUTOCOUNCIL_CLARIFY;
    expect(isAutoCouncilClarifyEnabled()).toBe(true);
  });

  it("env '0' / 'false' disables the pre-debate interview (wins over settings)", () => {
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "0";
    expect(isAutoCouncilClarifyEnabled()).toBe(false);
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "false";
    expect(isAutoCouncilClarifyEnabled()).toBe(false);
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "FALSE";
    expect(isAutoCouncilClarifyEnabled()).toBe(false);
  });

  it("env '1' / 'true' force-enables", () => {
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "1";
    expect(isAutoCouncilClarifyEnabled()).toBe(true);
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "true";
    expect(isAutoCouncilClarifyEnabled()).toBe(true);
  });

  it("ignores an unrecognized env value and falls back to the default", () => {
    process.env.MUONROI_AUTOCOUNCIL_CLARIFY = "maybe";
    expect(isAutoCouncilClarifyEnabled()).toBe(true);
  });
});

describe("isAutoCouncilSkipReasoning", () => {
  const prev = process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING;
    else process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = prev;
  });

  it("defaults to true — auto-council skips reasoning models by default", () => {
    delete process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING;
    expect(isAutoCouncilSkipReasoning()).toBe(true);
  });

  it("env '0' / 'false' disables the skip (forces council for reasoning models)", () => {
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "0";
    expect(isAutoCouncilSkipReasoning()).toBe(false);
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "false";
    expect(isAutoCouncilSkipReasoning()).toBe(false);
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "FALSE";
    expect(isAutoCouncilSkipReasoning()).toBe(false);
  });

  it("env '1' / 'true' force-enables the skip", () => {
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "1";
    expect(isAutoCouncilSkipReasoning()).toBe(true);
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "true";
    expect(isAutoCouncilSkipReasoning()).toBe(true);
  });

  it("ignores an unrecognized env value and falls back to the default", () => {
    process.env.MUONROI_AUTOCOUNCIL_SKIP_REASONING = "maybe";
    expect(isAutoCouncilSkipReasoning()).toBe(true);
  });
});
