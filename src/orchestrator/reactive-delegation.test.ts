import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getReactiveDelegationThresholdChars, shouldReactivelyEscalate } from "./reactive-delegation.js";

describe("getReactiveDelegationThresholdChars", () => {
  const prev = process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
    else process.env.MUONROI_REACTIVE_DELEGATE_CHARS = prev;
  });

  it("defaults to 120_000 when the env var is unset", () => {
    delete process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
    expect(getReactiveDelegationThresholdChars()).toBe(120_000);
  });

  it("honors a valid env override", () => {
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "50000";
    expect(getReactiveDelegationThresholdChars()).toBe(50_000);
  });

  it("allows 0 (disable) via env", () => {
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "0";
    expect(getReactiveDelegationThresholdChars()).toBe(0);
  });

  it("ignores non-numeric / negative env and falls back to default", () => {
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "abc";
    expect(getReactiveDelegationThresholdChars()).toBe(120_000);
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "-5";
    expect(getReactiveDelegationThresholdChars()).toBe(120_000);
  });
});

describe("shouldReactivelyEscalate", () => {
  it("escalates when prior-turn tool load meets/exceeds the threshold", () => {
    expect(shouldReactivelyEscalate(150_000, 120_000)).toBe(true);
    expect(shouldReactivelyEscalate(120_000, 120_000)).toBe(true);
  });

  it("does NOT escalate a light prior turn below the threshold", () => {
    expect(shouldReactivelyEscalate(20_000, 120_000)).toBe(false);
  });

  it("does NOT escalate on the first turn (no prior load)", () => {
    expect(shouldReactivelyEscalate(0, 120_000)).toBe(false);
  });

  it("is disabled when threshold is 0", () => {
    expect(shouldReactivelyEscalate(500_000, 0)).toBe(false);
  });

  it("guards against NaN / negative input", () => {
    expect(shouldReactivelyEscalate(Number.NaN, 120_000)).toBe(false);
    expect(shouldReactivelyEscalate(-1, 120_000)).toBe(false);
  });
});
