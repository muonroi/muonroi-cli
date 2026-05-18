import { describe, expect, it } from "vitest";
import { extractProviderOptionsShape } from "./provider-options-shape.js";

describe("extractProviderOptionsShape", () => {
  it("returns null for undefined/null/empty input", () => {
    expect(extractProviderOptionsShape(undefined)).toBeNull();
    expect(extractProviderOptionsShape(null)).toBeNull();
    expect(extractProviderOptionsShape({})).toBeNull();
    expect(extractProviderOptionsShape([])).toBeNull();
    // Non-object primitives also return null (defensive).
    expect(extractProviderOptionsShape("abc")).toBeNull();
    expect(extractProviderOptionsShape(42)).toBeNull();
  });

  it("replaces flat-object leaves with typeof strings (no values leaked)", () => {
    const shape = extractProviderOptionsShape({
      openai: { store: true, promptCacheKey: "abc-secret-xyz" },
    });
    expect(shape).not.toBeNull();
    const parsed = JSON.parse(shape as string);
    expect(parsed).toEqual({
      openai: { store: "boolean", promptCacheKey: "string" },
    });
    // Hard guarantee: the actual key value is never in the output.
    expect(shape).not.toContain("abc-secret-xyz");
  });

  it("recurses into nested objects (depth 2)", () => {
    const shape = extractProviderOptionsShape({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8192,
        },
      },
    });
    expect(JSON.parse(shape as string)).toEqual({
      anthropic: {
        thinking: {
          type: "string",
          budgetTokens: "number",
        },
      },
    });
  });

  it("caps recursion at depth 4 to avoid runaway/circular structures", () => {
    // Build a 6-deep nested object: a.b.c.d.e.f = "leaf"
    const deep = { a: { b: { c: { d: { e: { f: "leaf" } } } } } };
    const shape = extractProviderOptionsShape(deep);
    const parsed = JSON.parse(shape as string);
    // Depths 0..3 are walked (a, b, c, d) — at depth 4 we truncate.
    // The element at the 4-deep position should be the truncated marker.
    expect(parsed.a.b.c.d).toBe("<max-depth>");
    // And no actual leaf value survives.
    expect(shape).not.toContain("leaf");
  });

  it("preserves arrays and recurses into their elements", () => {
    const shape = extractProviderOptionsShape({
      xai: { stopSequences: ["foo", "bar"], topLogprobs: 3 },
    });
    expect(JSON.parse(shape as string)).toEqual({
      xai: { stopSequences: ["string", "string"], topLogprobs: "number" },
    });
  });
});
