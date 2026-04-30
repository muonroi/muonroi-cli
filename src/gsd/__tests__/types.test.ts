import { describe, expect, it } from "vitest";
import { GSD_PHASES, isGsdPhase, detectGsdPhase, type GsdPhase } from "../types";

describe("GSD types", () => {
  it("GSD_PHASES contains all expected phases", () => {
    expect(GSD_PHASES).toContain("discuss");
    expect(GSD_PHASES).toContain("plan");
    expect(GSD_PHASES).toContain("execute");
    expect(GSD_PHASES).toContain("verify");
    expect(GSD_PHASES).toContain("review");
    expect(GSD_PHASES.length).toBe(5);
  });

  it("isGsdPhase returns true for valid phases", () => {
    expect(isGsdPhase("discuss")).toBe(true);
    expect(isGsdPhase("plan")).toBe(true);
    expect(isGsdPhase("execute")).toBe(true);
    expect(isGsdPhase("verify")).toBe(true);
    expect(isGsdPhase("review")).toBe(true);
  });

  it("isGsdPhase returns false for invalid strings", () => {
    expect(isGsdPhase("unknown")).toBe(false);
    expect(isGsdPhase("")).toBe(false);
    expect(isGsdPhase("PLAN")).toBe(false);
  });

  it("detectGsdPhase detects plan from keywords", () => {
    expect(detectGsdPhase("plan the implementation")).toBe("plan");
    expect(detectGsdPhase("let's plan this feature")).toBe("plan");
  });

  it("detectGsdPhase detects execute from keywords", () => {
    expect(detectGsdPhase("execute the plan now")).toBe("execute");
    expect(detectGsdPhase("implement the feature")).toBe("execute");
    expect(detectGsdPhase("build the component")).toBe("execute");
  });

  it("detectGsdPhase detects verify from keywords", () => {
    expect(detectGsdPhase("verify the results")).toBe("verify");
    expect(detectGsdPhase("validate that it works")).toBe("verify");
    expect(detectGsdPhase("test the implementation")).toBe("verify");
  });

  it("detectGsdPhase detects review from keywords", () => {
    expect(detectGsdPhase("review the code")).toBe("review");
    expect(detectGsdPhase("audit the changes")).toBe("review");
  });

  it("detectGsdPhase detects discuss from keywords", () => {
    expect(detectGsdPhase("discuss the approach")).toBe("discuss");
    expect(detectGsdPhase("let's brainstorm ideas")).toBe("discuss");
  });

  it("detectGsdPhase returns null for no match", () => {
    expect(detectGsdPhase("hello world")).toBeNull();
    expect(detectGsdPhase("")).toBeNull();
  });
});
