import { afterEach, describe, expect, it } from "vitest";
import { getToolLimitAutoRecoverCap, shouldAutoRecoverToolLimit } from "../tool-limit-auto-recover.js";

// info.kind is the ToolLoopCapAskInfo union from tool-loop-cap.ts:25-28 —
// "cap" = tool-round/step ceiling reached; "pattern" = repeated-call loop.
describe("shouldAutoRecoverToolLimit", () => {
  it("recovers a cap (step-limit) halt while under the cap", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 0, 2)).toBe(true);
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 1, 2)).toBe(true);
  });
  it("stops recovering once the cap is reached", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 2, 2)).toBe(false);
  });
  it("never auto-recovers a pattern-loop halt (agent is stuck)", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "pattern" }, 0, 2)).toBe(false);
  });
});

describe("getToolLimitAutoRecoverCap", () => {
  const KEY = "MUONROI_TOOL_LIMIT_AUTO_RECOVER_CAP";
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it("defaults to 6 (raised from the historical 2 that stranded long tasks)", () => {
    delete process.env[KEY];
    expect(getToolLimitAutoRecoverCap()).toBe(6);
  });
  it("honors a valid env override", () => {
    process.env[KEY] = "10";
    expect(getToolLimitAutoRecoverCap()).toBe(10);
  });
  it("clamps to a max of 50", () => {
    process.env[KEY] = "999";
    expect(getToolLimitAutoRecoverCap()).toBe(50);
  });
  it("ignores non-numeric / < 1 values and falls back to default", () => {
    process.env[KEY] = "abc";
    expect(getToolLimitAutoRecoverCap()).toBe(6);
    process.env[KEY] = "0";
    expect(getToolLimitAutoRecoverCap()).toBe(6);
  });
});
