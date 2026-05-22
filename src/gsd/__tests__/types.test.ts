import { describe, expect, it } from "vitest";
import { detectGsdPhase, GSD_PHASES, isGsdPhase } from "../types";

describe("GSD types", () => {
  it("GSD_PHASES contains all expected phases", () => {
    expect(GSD_PHASES).toContain("discuss");
    expect(GSD_PHASES).toContain("plan");
    expect(GSD_PHASES).toContain("execute");
    expect(GSD_PHASES).toContain("verify");
    expect(GSD_PHASES).toContain("review");
    expect(GSD_PHASES).toContain("debug");
    expect(GSD_PHASES.length).toBe(6);
  });

  it("isGsdPhase returns true for valid phases", () => {
    expect(isGsdPhase("discuss")).toBe(true);
    expect(isGsdPhase("plan")).toBe(true);
    expect(isGsdPhase("execute")).toBe(true);
    expect(isGsdPhase("verify")).toBe(true);
    expect(isGsdPhase("review")).toBe(true);
    expect(isGsdPhase("debug")).toBe(true);
  });

  it("detectGsdPhase routes fix/debug language to debug phase (session 127140a47b56)", () => {
    // Position-based detection: when a debug keyword appears first, debug wins.
    expect(detectGsdPhase("fix CI fail")).toBe("debug");
    expect(detectGsdPhase("fix lỗi và check lại CI")).toBe("debug");
    expect(detectGsdPhase("sửa bug này giúp tôi")).toBe("debug");
    expect(detectGsdPhase("debug this crash")).toBe("debug");
    // The exact session 127140a47b56 prompt — "fix" beats later "check".
    expect(detectGsdPhase("action github đang run fail check và fix cho tôi")).toBe("debug");
    // Without explicit debug keywords, "check" still falls through to verify.
    expect(detectGsdPhase("check that this works")).toBe("verify");
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

describe("detectGsdPhase — ambiguity resolution", () => {
  it("'implement the plan' returns execute (action verb wins)", () => {
    expect(detectGsdPhase("implement the plan")).toBe("execute");
  });

  it("'plan the implementation' returns plan (plan appears first)", () => {
    expect(detectGsdPhase("plan the implementation")).toBe("plan");
  });

  it("'discuss the plan before executing' returns discuss (discuss first)", () => {
    expect(detectGsdPhase("discuss the plan before executing")).toBe("discuss");
  });

  it("'build and verify the feature' returns execute (build first)", () => {
    expect(detectGsdPhase("build and verify the feature")).toBe("execute");
  });
});
