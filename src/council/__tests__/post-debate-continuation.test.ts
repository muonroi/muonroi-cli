/**
 * Post-debate continuation policy — the single source of truth shared by the
 * `/council` slash path (orchestrator.runCouncilV2) and the auto-council path
 * (tool-engine). Before this helper the two diverged: the slash path only
 * continued on `continue_session`, while auto-council continued UNCONDITIONALLY
 * with a fixed "Proceed with the recommended action items" prompt — meaningless
 * for an evaluation/decision debate with no action items, which is what made the
 * post-debate askcard feel like it did nothing.
 */
import { describe, expect, it } from "vitest";
import { postDebateContinuation } from "../index.js";

const SYNTH = "The council concluded X.";

describe("postDebateContinuation", () => {
  it("continue_session carries the conclusion forward on the original task", () => {
    const p = postDebateContinuation("continue_session", SYNTH);
    expect(p).toContain(SYNTH);
    expect(p).toContain("Continue the original task");
  });

  it("generate_plan / implement proceed with the action items", () => {
    for (const action of ["generate_plan", "implement"]) {
      const p = postDebateContinuation(action, SYNTH);
      expect(p).toContain(SYNTH);
      expect(p).toContain("Proceed with the recommended action items");
    }
  });

  it("save_exit stops at the composer (deliverable is the conclusion)", () => {
    expect(postDebateContinuation("save_exit", SYNTH)).toBeNull();
  });

  it("refine / retry_synthesis / follow-up text do not re-enter (already handled inside runCouncil)", () => {
    for (const action of ["refine", "retry_synthesis", "what about edge cases?"]) {
      expect(postDebateContinuation(action, SYNTH)).toBeNull();
    }
  });

  it("returns null when there is no synthesis or no action", () => {
    expect(postDebateContinuation("continue_session", "")).toBeNull();
    expect(postDebateContinuation(undefined, SYNTH)).toBeNull();
  });
});
