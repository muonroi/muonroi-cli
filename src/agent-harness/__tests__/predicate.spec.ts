import { describe, expect, it } from "vitest";
import { evaluatePredicate, predicateSchema } from "../predicate";
import type { UINode } from "../protocol";

const node: UINode = { id: "x", role: "button", name: "Send", focus: true };

describe("predicate", () => {
  it("parses a field-op predicate", () => {
    const p = predicateSchema.parse({ field: "name", op: "eq", rhs: "Send" });
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("parses a flag predicate", () => {
    const p = predicateSchema.parse({ flag: "focus", value: true });
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("supports all/any/not", () => {
    const p = predicateSchema.parse({
      all: [{ field: "name", op: "contains", rhs: "Sen" }, { not: { flag: "disabled", value: true } }],
    });
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("rejects unknown shapes", () => {
    expect(() => predicateSchema.parse({ field: "x", op: "weird", rhs: "y" })).toThrow();
  });

  it("rejects rhs longer than 200 chars (ReDoS guard)", () => {
    const huge = "a".repeat(201);
    expect(() => predicateSchema.parse({ field: "name", op: "regex", rhs: huge })).toThrow();
  });
});
