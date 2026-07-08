/**
 * Post-debate continuation policy — the single source of truth shared by the
 * `/council` slash path (orchestrator.runCouncilV2) and the auto-council path
 * (tool-engine). Before this helper the two diverged: the slash path only
 * continued on `continue_session`, while auto-council continued UNCONDITIONALLY
 * with a fixed "Proceed with the recommended action items" prompt — meaningless
 * for an evaluation/decision debate with no action items, which is what made the
 * post-debate askcard feel like it did nothing.
 *
 * Session 578b2eae7099: `continue_session` on an ANALYSIS/EVALUATION debate fed
 * "Continue the original task using this conclusion." back into the agent loop,
 * which the model read as a build mandate — it created phantom Phase-1..7 todos
 * and started editing files, then the rogue implementation turn wedged the UI at
 * "Council working… elapsed 0s". continue_session is now shape-aware: only an
 * implementation-shaped debate carries the task forward; analysis re-enters with
 * an explicit no-implementation directive so the conclusion stays the deliverable.
 */
import { describe, expect, it } from "vitest";
import { postDebateContinuation } from "../index.js";

const IMPL_SYNTH = '```json\n{\n  "type": "implementation_plan",\n  "summary": "build X"\n}\n```';
const EVAL_SYNTH = '```json\n{\n  "type": "evaluation",\n  "summary": "assess X"\n}\n```';
const PLAIN_SYNTH = "The council concluded X.";

describe("postDebateContinuation", () => {
  it("continue_session carries the task forward for an implementation_plan debate", () => {
    const p = postDebateContinuation("continue_session", IMPL_SYNTH);
    expect(p).toContain(IMPL_SYNTH);
    expect(p).toContain("Continue the original task");
  });

  it("continue_session on an evaluation debate re-enters WITHOUT an implementation mandate", () => {
    const p = postDebateContinuation("continue_session", EVAL_SYNTH);
    expect(p).toContain(EVAL_SYNTH);
    expect(p).not.toContain("Continue the original task");
    expect(p?.toLowerCase()).toContain("do not");
    // Names the concrete drift behaviours the bug produced.
    expect(p?.toLowerCase()).toMatch(/edit|plan|todo|sub-agent/);
  });

  it("continue_session defaults to no-implementation when the shape is unknown", () => {
    const p = postDebateContinuation("continue_session", PLAIN_SYNTH);
    expect(p).not.toContain("Continue the original task");
    expect(p?.toLowerCase()).toContain("do not");
  });

  it("explicit outputKind overrides the synthesis-derived kind", () => {
    // A plain-text synthesis but the caller knows the shape is an implementation plan.
    const p = postDebateContinuation("continue_session", PLAIN_SYNTH, "implementation_plan");
    expect(p).toContain("Continue the original task");
  });

  it("generate_plan / implement proceed with the action items", () => {
    for (const action of ["generate_plan", "implement"]) {
      const p = postDebateContinuation(action, EVAL_SYNTH);
      expect(p).toContain(EVAL_SYNTH);
      expect(p).toContain("Proceed with the recommended action items");
    }
  });

  it("save_exit stops at the composer (deliverable is the conclusion)", () => {
    expect(postDebateContinuation("save_exit", EVAL_SYNTH)).toBeNull();
  });

  it("refine / retry_synthesis / follow-up text do not re-enter (already handled inside runCouncil)", () => {
    for (const action of ["refine", "retry_synthesis", "what about edge cases?"]) {
      expect(postDebateContinuation(action, EVAL_SYNTH)).toBeNull();
    }
  });

  it("returns null when there is no synthesis or no action", () => {
    expect(postDebateContinuation("continue_session", "")).toBeNull();
    expect(postDebateContinuation(undefined, EVAL_SYNTH)).toBeNull();
  });
});
