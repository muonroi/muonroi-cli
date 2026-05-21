// src/product-loop/__tests__/discovery-prompt-specificity.test.ts
//
// P2-5: unit tests for computePromptSpecificity. The buckets drive default
// scope sizing in the leader prompt — a misclassification cascades into
// wrong defaults (e.g. "saas/100-1k SMB" for a 5-word "tạo todo app" prompt).
import { describe, expect, it } from "vitest";
import { computePromptSpecificity } from "../discovery-recommender.js";

describe("computePromptSpecificity", () => {
  it('returns "minimal" for undefined / empty prompt', () => {
    expect(computePromptSpecificity(undefined)).toBe("minimal");
    expect(computePromptSpecificity("")).toBe("minimal");
    expect(computePromptSpecificity("   ")).toBe("minimal");
  });

  it('returns "minimal" for the canonical regression case "tôi muốn tạo todo app"', () => {
    // 5 words, no qualifiers — this is the prompt that produced the
    // multi-tenant SaaS plan in session f1cec5324716. MUST be minimal.
    expect(computePromptSpecificity("tôi muốn tạo todo app")).toBe("minimal");
  });

  it('returns "minimal" for English equivalents at <=10 words with no qualifiers', () => {
    expect(computePromptSpecificity("build a todo app")).toBe("minimal");
    expect(computePromptSpecificity("create a simple wiki")).toBe("minimal");
    expect(computePromptSpecificity("I want a habit tracker please")).toBe("minimal");
  });

  it('returns "moderate" when a single qualifier appears even in short prompt', () => {
    // "team" is a qualifier — implies multi-user → not minimal scope
    expect(computePromptSpecificity("build a team todo app")).toBe("moderate");
    expect(computePromptSpecificity("simple wiki with auth")).toBe("moderate");
  });

  it('returns "moderate" for 10-40 word prompt without strong scale signals', () => {
    const prompt =
      "I want to build a todo app where I can group tasks by project and " +
      "filter by due date and tag, with a clean minimal interface";
    expect(computePromptSpecificity(prompt)).toBe("moderate");
  });

  it('returns "detailed" for >40 word prompt', () => {
    const prompt =
      "I want to build a project management tool similar to Linear but focused " +
      "on solo developers and small teams of up to five people. Must support " +
      "GitHub issue sync, keyboard shortcuts, a CLI for quick capture from the " +
      "terminal, and a clean dark theme by default with optional light mode.";
    expect(computePromptSpecificity(prompt)).toBe("detailed");
  });

  it('returns "detailed" when prompt has >=3 qualifiers even if short', () => {
    // 3 hits: team, saas, postgres → detailed even at moderate length
    expect(computePromptSpecificity("team todo saas with postgres")).toBe("detailed");
  });

  it("is case-insensitive on qualifier matching", () => {
    expect(computePromptSpecificity("Build a TEAM todo app")).toBe("moderate");
    expect(computePromptSpecificity("TODO with REACT and POSTGRES auth")).toBe("detailed");
  });

  it("does NOT confuse partial matches that happen to contain a keyword substring inappropriately", () => {
    // Sanity: "user" is not in QUALIFIER_KEYWORDS (only "users" plural is).
    // A prompt mentioning "the user types" should still be minimal.
    expect(computePromptSpecificity("an app where the user types tasks")).toBe("minimal");
  });
});
