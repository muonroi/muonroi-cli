import { describe, expect, it } from "vitest";
import { extractStructuredVerdict, PlanCouncilVerdictSchema, VERDICT_OUTPUT_CONTRACT } from "../verdict-schema.js";

describe("PlanCouncilVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    const parsed = PlanCouncilVerdictSchema.safeParse({
      verdict: "approve",
      concerns: [],
      evidence: ["src/foo.ts:12"],
    });
    expect(parsed.success).toBe(true);
  });

  it("coerces missing concerns/evidence to empty arrays", () => {
    const parsed = PlanCouncilVerdictSchema.parse({ verdict: "revise" });
    expect(parsed.concerns).toEqual([]);
    expect(parsed.evidence).toEqual([]);
  });

  it("rejects an unknown verdict value", () => {
    const parsed = PlanCouncilVerdictSchema.safeParse({ verdict: "maybe", concerns: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("extractStructuredVerdict", () => {
  it("returns null for empty / whitespace input", () => {
    expect(extractStructuredVerdict("")).toBeNull();
    expect(extractStructuredVerdict("   \n\n")).toBeNull();
  });

  it("returns null for prose-only with no JSON", () => {
    expect(extractStructuredVerdict("The plan looks fine. I do not see any blocker here. Ship it.")).toBeNull();
  });

  it("parses a fenced ```council-verdict block", () => {
    const raw = [
      "Reasoning about the plan...",
      "",
      "```council-verdict",
      '{"verdict":"revise","concerns":["missing retry path"],"evidence":[],"rationale":"retry gap"}',
      "```",
    ].join("\n");
    const v = extractStructuredVerdict(raw);
    expect(v?.verdict).toBe("revise");
    expect(v?.concerns).toEqual(["missing retry path"]);
    expect(v?.rationale).toBe("retry gap");
  });

  it("parses a fenced ```json block when no council-verdict fence exists", () => {
    const raw = ["```json", '{"verdict":"approve","concerns":[],"evidence":[]}', "```"].join("\n");
    expect(extractStructuredVerdict(raw)?.verdict).toBe("approve");
  });

  it("parses a bare (unlabeled) fenced block", () => {
    const raw = ["```\n" + '{"verdict":"block","concerns":["security hole"]}\n' + "```"].join("");
    expect(extractStructuredVerdict(raw)?.verdict).toBe("block");
  });

  it("parses a bare {...} substring when no fence exists (perspective path)", () => {
    const raw = '{"verdict":"approve","concerns":[],"evidence":[]}';
    expect(extractStructuredVerdict(raw)?.verdict).toBe("approve");
  });

  it("takes the LAST fenced verdict when multiple are present (model refines)", () => {
    const raw = [
      "First I considered: ```council-verdict",
      '{"verdict":"revise","concerns":["maybe X"]}',
      "```",
      "But on reflection: ```council-verdict",
      '{"verdict":"approve","concerns":[]}',
      "```",
    ].join("\n");
    expect(extractStructuredVerdict(raw)?.verdict).toBe("approve");
  });

  it("does not collide with an earlier JSON quote of plan acceptance criteria", () => {
    // Model quotes the plan's own acceptance JSON, then emits its verdict last.
    const raw = [
      'Plan acceptance was given as: {"acceptance":"buntest passes"}',
      "```council-verdict",
      '{"verdict":"revise","concerns":["no CI gate"]}',
      "```",
    ].join("\n");
    const v = extractStructuredVerdict(raw);
    expect(v?.verdict).toBe("revise");
    expect(v?.concerns).toEqual(["no CI gate"]);
  });

  it("skips a fence whose body is not valid verdict JSON, falls to next", () => {
    const raw = [
      "```council-verdict",
      '{"notaverdict":"lol"}',
      "```",
      "```council-verdict",
      '{"verdict":"approve","concerns":[]}',
      "```",
    ].join("\n");
    expect(extractStructuredVerdict(raw)?.verdict).toBe("approve");
  });

  it("returns null when fenced JSON lacks a valid verdict enum", () => {
    const raw = "```council-verdict\n" + '{"verdict":"maybe"}\n' + "```";
    expect(extractStructuredVerdict(raw)).toBeNull();
  });

  it("handles nested braces inside JSON string values (brace-balanced scan)", () => {
    const raw = '{"verdict":"revise","concerns":["code at function foo() { return null; } lacks guard"]}';
    const v = extractStructuredVerdict(raw);
    expect(v?.verdict).toBe("revise");
    expect(v?.concerns[0]).toContain("function foo()");
  });

  it("VERDICT_OUTPUT_CONTRACT contains the fenced shape and the three verdict values", () => {
    expect(VERDICT_OUTPUT_CONTRACT).toContain("```council-verdict");
    expect(VERDICT_OUTPUT_CONTRACT).toContain('"verdict"');
    expect(VERDICT_OUTPUT_CONTRACT).toContain("approve");
    expect(VERDICT_OUTPUT_CONTRACT).toContain("revise");
    expect(VERDICT_OUTPUT_CONTRACT).toContain("block");
  });
});
