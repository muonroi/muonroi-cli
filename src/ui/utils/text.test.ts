import { describe, expect, it } from "vitest";
import { hideLegacyCompletionReceipts, sanitizeContent, stripInvisibleChars, stripStrayModelMacros } from "./text.js";

describe("legacy internal completion receipt display", () => {
  const receipt =
    "[Native Flow evidence: plan-review=pass; implementation-verification=missing; whole-task completion=unverified. These artifact facts do not certify the model's completion claim.]";
  it("hides repeated trailing host receipts in historical and live assistant display", () => {
    const raw = `Actual progress.\nPRESERVE\n\n${receipt}\n\n${receipt}\n${receipt}`;
    expect(hideLegacyCompletionReceipts(raw)).toBe("Actual progress.\nPRESERVE");
    expect(sanitizeContent(raw)).toBe("Actual progress.\nPRESERVE");
    expect(raw).toContain(receipt);
    expect(hideLegacyCompletionReceipts(receipt)).toBe("");
  });
  it("retains prose, quoted examples, incomplete receipts and unrelated bracketed text", () => {
    for (const raw of [
      "Actual progress.\n",
      `[Native Flow evidence: incomplete]`,
      `Quoted: ${receipt}`,
      `\`\`\`text\n${receipt}\n\`\`\``,
      `${receipt}\nThe user asked about this text.`,
    ]) {
      expect(hideLegacyCompletionReceipts(raw)).toBe(raw);
    }
  });
});

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

describe("stripInvisibleChars", () => {
  it("strips zero-width spaces (U+200B)", () => {
    expect(stripInvisibleChars("hello\u200Bworld")).toBe("helloworld");
  });
  it("strips soft hyphen (U+00AD)", () => {
    expect(stripInvisibleChars("hy\u00ADphen")).toBe("hyphen");
  });
  it("strips BOM (U+FEFF)", () => {
    expect(stripInvisibleChars("\uFEFFHello")).toBe("Hello");
  });
  it("strips BiDi overrides (U+202E)", () => {
    expect(stripInvisibleChars("abc\u202Edef")).toBe("abcdef");
  });
  it("strips C0 controls except \\t \\n \\r", () => {
    expect(stripInvisibleChars("a\u0001b\rc\td")).toBe("ab\rc\td");
  });
  it("keeps normal text unchanged (fast path)", () => {
    const normal = "Hello world, how are you?";
    expect(stripInvisibleChars(normal)).toBe(normal);
  });
  it("handles empty string", () => {
    expect(stripInvisibleChars("")).toBe("");
  });
});
