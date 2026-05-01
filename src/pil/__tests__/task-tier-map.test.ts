import { describe, expect, it } from "vitest";
import { taskTypeToTier } from "../task-tier-map.js";

describe("taskTypeToTier — TaskType to EE tier mapping", () => {
  it("maps 'refactor' to 'balanced'", () => {
    expect(taskTypeToTier("refactor")).toBe("balanced");
  });

  it("maps 'debug' to 'balanced'", () => {
    expect(taskTypeToTier("debug")).toBe("balanced");
  });

  it("maps 'plan' to 'premium'", () => {
    expect(taskTypeToTier("plan")).toBe("premium");
  });

  it("maps 'analyze' to 'balanced'", () => {
    expect(taskTypeToTier("analyze")).toBe("balanced");
  });

  it("maps 'documentation' to 'fast'", () => {
    expect(taskTypeToTier("documentation")).toBe("fast");
  });

  it("maps 'generate' to 'balanced'", () => {
    expect(taskTypeToTier("generate")).toBe("balanced");
  });

  it("maps 'general' to 'fast'", () => {
    expect(taskTypeToTier("general")).toBe("fast");
  });

  it("maps null to 'fast'", () => {
    expect(taskTypeToTier(null)).toBe("fast");
  });

  it("maps unknown string to 'balanced' (default fallback)", () => {
    expect(taskTypeToTier("unknown")).toBe("balanced");
    expect(taskTypeToTier("foobar")).toBe("balanced");
  });
});
