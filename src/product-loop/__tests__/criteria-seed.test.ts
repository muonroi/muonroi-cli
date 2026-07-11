import { describe, expect, it } from "vitest";
import { criterionIdFromText, extractAcceptanceCriteria, planQualityIssues } from "../criteria-seed.js";

describe("extractAcceptanceCriteria", () => {
  it("pulls acceptance_criteria out of the council JSON block before ---READABLE---", () => {
    const synthesis =
      JSON.stringify({
        type: "implementation_plan",
        summary: "x",
        acceptance_criteria: [
          "GIVEN a symbol WHEN impact_of_change THEN references[] returned",
          "GIVEN LSP down WHEN impact_of_change THEN safeToRename=false",
        ],
      }) + "\n---READABLE---\nsome prose";
    const out = extractAcceptanceCriteria(synthesis);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("impact_of_change");
  });

  it("falls back to a markdown Acceptance Criteria bullet section", () => {
    const synthesis = `## Acceptance Criteria\n- first criterion here\n- second criterion here\n\n## Next\n- unrelated`;
    const out = extractAcceptanceCriteria(synthesis);
    expect(out).toEqual(["first criterion here", "second criterion here"]);
  });

  it("returns [] for empty or criteria-less input", () => {
    expect(extractAcceptanceCriteria("")).toEqual([]);
    expect(extractAcceptanceCriteria("{}")).toEqual([]);
    expect(extractAcceptanceCriteria("just prose, no plan")).toEqual([]);
  });

  it("dedupes case/space-insensitively", () => {
    const synthesis = JSON.stringify({ acceptance_criteria: ["Do  X", "do x", "Do Y"] });
    expect(extractAcceptanceCriteria(synthesis)).toEqual(["Do  X", "Do Y"]);
  });
});

describe("criterionIdFromText", () => {
  it("keeps short criteria verbatim (single line)", () => {
    expect(criterionIdFromText("short one")).toBe("short one");
    expect(criterionIdFromText("a\nb  c")).toBe("a b c");
  });

  it("truncates long criteria but keeps distinct suffixes for shared prefixes", () => {
    const prefix = "x".repeat(80);
    const a = criterionIdFromText(prefix + " ALPHA");
    const b = criterionIdFromText(prefix + " BETA");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(72);
  });
});

describe("planQualityIssues", () => {
  it("flags missing acceptance criteria and missing file_edits", () => {
    const issues = planQualityIssues("just some prose plan", 0);
    expect(issues).toHaveLength(2);
    expect(issues.join(" ")).toMatch(/acceptance_criteria/);
    expect(issues.join(" ")).toMatch(/file_edits/);
  });

  it("is clean when the plan has criteria and file_edits", () => {
    const plan = JSON.stringify({ file_edits: [{ file: "a.ts", edit: "x" }] });
    expect(planQualityIssues(plan, 3)).toEqual([]);
  });
});
