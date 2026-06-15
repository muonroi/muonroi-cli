import { describe, expect, it } from "vitest";
import { stripStrayModelMacros } from "./text.js";

describe("stripStrayModelMacros", () => {
  it("strips a trailing \\confidence{NN} macro and the blank line before it", () => {
    const input = "Root cause: parseInt radix.\n\nFix: use radix 10.\n\n\\confidence{85}";
    expect(stripStrayModelMacros(input)).toBe("Root cause: parseInt radix.\n\nFix: use radix 10.");
  });

  it("strips a mid-text \\confidence macro too", () => {
    expect(stripStrayModelMacros("answer \\confidence{90} continues")).toBe("answer  continues");
  });

  it("is a no-op when no macro is present (fast path)", () => {
    const clean = "A normal answer with `\\frac{a}{b}` LaTeX that must survive.";
    expect(stripStrayModelMacros(clean)).toBe(clean);
  });

  it("does not touch other backslash macros (conservative)", () => {
    const latex = "Use \\frac{1}{2} and \\sum_{i}.";
    expect(stripStrayModelMacros(latex)).toBe(latex);
  });

  it("handles empty / falsy input", () => {
    expect(stripStrayModelMacros("")).toBe("");
  });
});
