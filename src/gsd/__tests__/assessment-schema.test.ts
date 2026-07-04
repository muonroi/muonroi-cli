import { describe, expect, it } from "vitest";
import { extractComplexityVerdict } from "../assessment-schema.js";

describe("extractComplexityVerdict", () => {
  it("extracts the last fenced complexity-verdict block", () => {
    const raw =
      'reasoning...\n```complexity-verdict\n{"depth":"heavy","autoCouncil":true,"rationale":"multi-file refactor"}\n```';
    expect(extractComplexityVerdict(raw)).toEqual({
      depth: "heavy",
      autoCouncil: true,
      rationale: "multi-file refactor",
    });
  });
  it("returns null when no valid verdict block is present", () => {
    expect(extractComplexityVerdict("no json here")).toBeNull();
  });
  it("coerces a missing autoCouncil to false", () => {
    const v = extractComplexityVerdict('```complexity-verdict\n{"depth":"quick"}\n```');
    expect(v?.depth).toBe("quick");
    expect(v?.autoCouncil).toBe(false);
  });
});
