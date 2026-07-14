/**
 * The agent-operating-contract council line (Task 5) — front-loaded, non-binding
 * agent-intent nudge for the convene_council flow. It must NOT hardcode a
 * post-council option set or a forced branch (user directive): the agent decides.
 */
import { describe, expect, it } from "vitest";
import { AGENT_OPERATING_CONTRACT, buildContractSection } from "../agent-operating-contract.js";

describe("agent-operating-contract — council line", () => {
  it("mentions convene_council and frames the post-council choice as the agent's own", () => {
    expect(AGENT_OPERATING_CONTRACT).toContain("convene_council");
    // Non-binding: the agent decides. Assert the "you decide" framing is present.
    expect(AGENT_OPERATING_CONTRACT.toLowerCase()).toMatch(/you decide|your call|decide/);
  });

  it("does NOT hardcode a post-council option set or a forced continue/implement branch", () => {
    const line = AGENT_OPERATING_CONTRACT.split("\n").find((l) => l.includes("convene_council")) ?? "";
    // No enumerated CLI option set (e.g. "1) save 2) implement 3) refine").
    expect(line).not.toMatch(/\bsave_exit\b|\bgenerate_plan\b|\brefine\b|option 1|choose one of/i);
  });

  it("is emitted at the front of the contract section (primacy)", () => {
    const section = buildContractSection();
    expect(section).toContain("convene_council");
    expect(section.startsWith("[AGENT OPERATING CONTRACT")).toBe(true);
  });
});
