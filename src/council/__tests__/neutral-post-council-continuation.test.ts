import { describe, expect, it } from "vitest";
import { buildNeutralPostCouncilContinuation } from "../index.js";

describe("buildNeutralPostCouncilContinuation", () => {
  const SYNTH = '```json\n{"type":"analysis","conclusion":"Use approach 2"}\n```';

  it("embeds the synthesis verbatim", () => {
    expect(buildNeutralPostCouncilContinuation(SYNTH)).toContain(SYNTH);
  });

  it("hands the decision to the agent without enumerating a fixed CLI option set", () => {
    const p = buildNeutralPostCouncilContinuation(SYNTH);
    // Non-binding: names the agent's OWN capabilities, not a menu the CLI adjudicates.
    expect(p).toMatch(/ask_user/);
    expect(p).toMatch(/respond|deliverable/i);
    expect(p).toMatch(/implement/i);
    // Must NOT re-introduce the hardcoded action tokens the card used.
    expect(p).not.toMatch(/continue_session|generate_plan|save_exit/);
  });

  it("returns empty string for a blank synthesis (no continuation)", () => {
    expect(buildNeutralPostCouncilContinuation("")).toBe("");
    expect(buildNeutralPostCouncilContinuation("   \n ")).toBe("");
  });
});
