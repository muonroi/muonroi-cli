import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLeaderDirective } from "../debate.js";
import { buildFollowupPrompt } from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

/**
 * The leader graded every round with a real model call (`evaluateDebate`, using
 * leaderModelId) and the result reached the UI and the round record — and
 * nothing else. `roundDirective` was composed at debate.ts:1317 and the follow-up
 * prompt was handed only `steering: steerBlock`, the HUMAN half. The leader's
 * half was dropped, so speakers never learned which criteria were still unmet or
 * what the leader wanted next, and each round restarted from the same spec.
 *
 * Observed live in session 98c8293f6d04: several rounds in, the run card still
 * read "Criteria 0/3" with no visible change of direction between rounds.
 */

const spec = {
  problemStatement: "Detect rule violations",
  successCriteria: ["Detects violations", "Shows a warning", "Applies principles consistently"],
  // extractStackFromSpec reads constraints/scope; omitting them throws in the
  // stack-lock builder, which is unrelated to what this file is pinning.
  constraints: [],
  scope: "",
} as unknown as ClarifiedSpec;

describe("the leader's directive actually reaches the speakers", () => {
  it("renders the directive in the prompt TAIL, labelled as the leader's", () => {
    const directive = buildLeaderDirective(2, spec.successCriteria, [false, false, false], "close the warning gap");
    const { system, prompt } = buildFollowupPrompt({
      speakerRole: "Architect",
      partnerRole: "Reviewer",
      partnerPosition: "their take",
      round: 2,
      spec,
      leaderDirective: directive,
    });

    expect(prompt).toContain("Leader directive for this round");
    expect(prompt).toContain("close the warning gap");
    // The unmet criteria must be visible — that is the information the speakers
    // were missing while the run sat at 0/3.
    expect(prompt).toContain("Shows a warning");
    // Tail only: putting per-round content in `system` breaks the cacheable
    // prefix on exactly the rounds the leader is steering.
    expect(system).not.toContain("Leader directive for this round");
  });

  it("keeps the human's steering distinguishable from the leader's directive", () => {
    const { prompt } = buildFollowupPrompt({
      speakerRole: "Architect",
      partnerRole: "Reviewer",
      partnerPosition: "their take",
      round: 3,
      spec,
      steering: "HUMAN: stop widening scope",
      leaderDirective: buildLeaderDirective(3, spec.successCriteria, [true, false, false]),
    });
    // Both present, and the human's instruction still leads.
    expect(prompt).toContain("HUMAN: stop widening scope");
    expect(prompt).toContain("Leader directive for this round");
    expect(prompt.indexOf("HUMAN: stop widening scope")).toBeLessThan(prompt.indexOf("Leader directive"));
  });

  it("adds nothing when the conductor produced no directive", () => {
    const { prompt } = buildFollowupPrompt({
      speakerRole: "Architect",
      partnerRole: "Reviewer",
      partnerPosition: "their take",
      round: 2,
      spec,
    });
    expect(prompt).not.toContain("Leader directive");
  });

  it("is wired at the debate call site, not just available in the builder", () => {
    // The defect was never in the builder — it was that the call site passed
    // only `steerBlock`. A builder-only test would have stayed green through it.
    const src = readFileSync(resolve("src/council/debate.ts"), "utf8");
    const wired = src.split(/\r?\n/).filter((l) => l.includes("leaderDirective: leaderDirectiveBlock"));
    // Both speakers of the pair (a and b) must receive it.
    expect(wired.length).toBe(2);
  });
});
