import { describe, expect, it } from "vitest";
import { FLOW_PHASES, isFlowPhase } from "../types";

describe("FLOW types", () => {
  it("FLOW_PHASES contains all expected phases", () => {
    expect(FLOW_PHASES).toContain("discuss");
    expect(FLOW_PHASES).toContain("plan");
    expect(FLOW_PHASES).toContain("execute");
    expect(FLOW_PHASES).toContain("verify");
    expect(FLOW_PHASES).toContain("review");
    expect(FLOW_PHASES).toContain("debug");
    expect(FLOW_PHASES.length).toBe(6);
  });

  it("isFlowPhase returns true for valid phases", () => {
    expect(isFlowPhase("discuss")).toBe(true);
    expect(isFlowPhase("plan")).toBe(true);
    expect(isFlowPhase("execute")).toBe(true);
    expect(isFlowPhase("verify")).toBe(true);
    expect(isFlowPhase("review")).toBe(true);
    expect(isFlowPhase("debug")).toBe(true);
  });

  it("isFlowPhase returns false for invalid strings", () => {
    expect(isFlowPhase("unknown")).toBe(false);
    expect(isFlowPhase("")).toBe(false);
    expect(isFlowPhase("PLAN")).toBe(false);
  });
});
