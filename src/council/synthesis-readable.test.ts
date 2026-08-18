/**
 * Regression for the post-council "raw debate" fix (session 47b3a8a546ca): the
 * synthesis is `<json>---READABLE---<markdown>` and the follow-up path was feeding
 * / persisting the RAW JSON, so the user saw a raw evaluation dump instead of a
 * consolidated reply (and the fragile follow-up turn stalled).
 */
import { describe, expect, it } from "vitest";
import { buildNeutralPostCouncilContinuation, extractReadableSynthesis, synthesisIsImplementation } from "./index.js";

const JSON_PART = '{"type":"evaluation","summary":"S","priority_roadmap":[1,2,3],"recommendation":"R"}';
const READABLE = "## Strengths\n\n- one\n- two\n\n## Recommendation\n\nDo the thing.";
const FULL = `${JSON_PART}\n---READABLE---\n${READABLE}`;

describe("extractReadableSynthesis", () => {
  it("returns only the prose after ---READABLE---", () => {
    expect(extractReadableSynthesis(FULL)).toBe(READABLE);
  });

  it("returns the whole string when there is no separator (plain synthesis)", () => {
    expect(extractReadableSynthesis("just prose, no json")).toBe("just prose, no json");
  });

  it("never leaks the raw JSON", () => {
    expect(extractReadableSynthesis(FULL)).not.toContain('"type"');
    expect(extractReadableSynthesis(FULL)).not.toContain("priority_roadmap");
  });

  it("handles empty input", () => {
    expect(extractReadableSynthesis("")).toBe("");
  });
});

describe("synthesisIsImplementation", () => {
  it("is false for an evaluation deliverable (self-contained answer)", () => {
    expect(synthesisIsImplementation(FULL)).toBe(false);
  });

  it("is false for analysis / decision / investigation kinds", () => {
    for (const kind of ["analysis", "decision", "investigation", "evaluation"]) {
      expect(synthesisIsImplementation(`{"type":"${kind}"}`)).toBe(false);
    }
  });

  it("is true only for an implementation_plan deliverable", () => {
    expect(synthesisIsImplementation('{"type":"implementation_plan"}')).toBe(true);
  });

  it("is false when no type is present", () => {
    expect(synthesisIsImplementation("no json here")).toBe(false);
  });
});

describe("buildNeutralPostCouncilContinuation", () => {
  it("embeds the READABLE prose, never the raw JSON", () => {
    const prompt = buildNeutralPostCouncilContinuation(FULL);
    expect(prompt).toContain(READABLE);
    expect(prompt).not.toContain('"type":"evaluation"');
    expect(prompt).not.toContain("priority_roadmap");
  });

  it("returns empty string for empty synthesis (caller skips re-entry)", () => {
    expect(buildNeutralPostCouncilContinuation("")).toBe("");
    expect(buildNeutralPostCouncilContinuation("   ")).toBe("");
  });
});
