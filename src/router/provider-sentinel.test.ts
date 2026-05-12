import { describe, expect, it } from "vitest";
import { isInheritProvider, PROVIDER_INHERIT } from "./provider-sentinel.js";

describe("provider-sentinel", () => {
  it("PROVIDER_INHERIT is the empty string (load-bearing contract with constrainToProvider)", () => {
    expect(PROVIDER_INHERIT).toBe("");
  });

  it("isInheritProvider returns true for empty / nullish values", () => {
    expect(isInheritProvider(PROVIDER_INHERIT)).toBe(true);
    expect(isInheritProvider("")).toBe(true);
    expect(isInheritProvider(undefined)).toBe(true);
    expect(isInheritProvider(null)).toBe(true);
  });

  it("isInheritProvider returns false for any concrete provider id", () => {
    expect(isInheritProvider("anthropic")).toBe(false);
    expect(isInheritProvider("openai")).toBe(false);
    expect(isInheritProvider("deepseek")).toBe(false);
    expect(isInheritProvider("ollama")).toBe(false);
  });
});
