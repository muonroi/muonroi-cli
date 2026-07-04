import { describe, expect, it } from "vitest";
import { ASSESSMENT_OUTPUT_CONTRACT, extractComplexityVerdict } from "../assessment-schema.js";

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
  it("extracts a bare (unfenced) valid object", () => {
    const raw = '{"depth":"quick","autoCouncil":false,"rationale":"ok"}';
    expect(extractComplexityVerdict(raw)).toEqual({
      depth: "quick",
      autoCouncil: false,
      rationale: "ok",
    });
  });
  it("still extracts when rationale contains a literal brace", () => {
    const raw = '{"depth":"quick","autoCouncil":false,"rationale":"handle the { edge case"}';
    const v = extractComplexityVerdict(raw);
    expect(v).not.toBeNull();
    expect(v?.depth).toBe("quick");
  });
});

describe("assessment-schema quality + enrichment", () => {
  it("parses a verdict carrying quality + enrichedPrompt", () => {
    const raw = [
      "```complexity-verdict",
      JSON.stringify({
        depth: "heavy",
        autoCouncil: true,
        rationale: "multi-file refactor",
        quality: { verdict: "enriched", missing: ["acceptance"], noiseRisk: "low" },
        enrichedPrompt: "Intent: ...\nLikely area: src/auth/ (confirm via grep before anchoring)",
      }),
      "```",
    ].join("\n");
    const v = extractComplexityVerdict(raw);
    expect(v?.quality?.verdict).toBe("enriched");
    expect(v?.quality?.missing).toEqual(["acceptance"]);
    expect(v?.quality?.noiseRisk).toBe("low");
    expect(v?.enrichedPrompt).toContain("confirm via grep");
  });

  it("still parses a depth-only verdict (backward compatible)", () => {
    const raw = '```complexity-verdict\n{"depth":"quick","autoCouncil":false,"rationale":"typo"}\n```';
    const v = extractComplexityVerdict(raw);
    expect(v?.depth).toBe("quick");
    expect(v?.quality).toBeUndefined();
    expect(v?.enrichedPrompt).toBeUndefined();
  });

  it("contract mentions the quality + enrichment fields", () => {
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/quality/);
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/enrichedPrompt/);
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/noiseRisk/);
  });
});
