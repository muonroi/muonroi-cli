import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAutoPassThreshold, getMaxInterviewQuestions, isDiscoveryEnabled, isUnifiedPilEnabled } from "../config.js";

describe("isUnifiedPilEnabled", () => {
  const orig = process.env.MUONROI_PIL_UNIFIED;
  beforeEach(() => {
    delete process.env.MUONROI_PIL_UNIFIED;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.MUONROI_PIL_UNIFIED;
    else process.env.MUONROI_PIL_UNIFIED = orig;
  });

  it("returns false by default (rollout phase)", () => {
    expect(isUnifiedPilEnabled()).toBe(false);
  });

  it("returns true when MUONROI_PIL_UNIFIED=1", () => {
    process.env.MUONROI_PIL_UNIFIED = "1";
    expect(isUnifiedPilEnabled()).toBe(true);
  });

  it("returns false when MUONROI_PIL_UNIFIED=0", () => {
    process.env.MUONROI_PIL_UNIFIED = "0";
    expect(isUnifiedPilEnabled()).toBe(false);
  });

  it("returns false for any other value", () => {
    process.env.MUONROI_PIL_UNIFIED = "yes";
    expect(isUnifiedPilEnabled()).toBe(false);
  });
});

describe("isDiscoveryEnabled()", () => {
  it("returns true by default (no env)", () => {
    delete process.env.MUONROI_PIL_DISCOVERY;
    expect(isDiscoveryEnabled()).toBe(true);
  });
  it("returns false when MUONROI_PIL_DISCOVERY=0", () => {
    process.env.MUONROI_PIL_DISCOVERY = "0";
    expect(isDiscoveryEnabled()).toBe(false);
    delete process.env.MUONROI_PIL_DISCOVERY;
  });
  it("returns true when MUONROI_PIL_DISCOVERY=1", () => {
    process.env.MUONROI_PIL_DISCOVERY = "1";
    expect(isDiscoveryEnabled()).toBe(true);
    delete process.env.MUONROI_PIL_DISCOVERY;
  });
});

describe("getAutoPassThreshold()", () => {
  it("returns 0.85 by default", () => {
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
    expect(getAutoPassThreshold()).toBe(0.85);
  });
  it("respects env override in range", () => {
    process.env.MUONROI_PIL_AUTOPASS_THRESHOLD = "0.7";
    expect(getAutoPassThreshold()).toBe(0.7);
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
  });
  it("clamps out-of-range to default", () => {
    process.env.MUONROI_PIL_AUTOPASS_THRESHOLD = "1.5";
    expect(getAutoPassThreshold()).toBe(0.85);
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
  });
});

describe("getMaxInterviewQuestions()", () => {
  it("returns 3 by default", () => {
    delete process.env.MUONROI_PIL_MAX_QUESTIONS;
    expect(getMaxInterviewQuestions()).toBe(3);
  });
  it("respects valid override", () => {
    process.env.MUONROI_PIL_MAX_QUESTIONS = "2";
    expect(getMaxInterviewQuestions()).toBe(2);
    delete process.env.MUONROI_PIL_MAX_QUESTIONS;
  });
});
