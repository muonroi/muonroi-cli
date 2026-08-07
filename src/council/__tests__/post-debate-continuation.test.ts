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
 * "Council working… elapsed 0s".
 *
 * Session 8191ecaee149 (user-driven redesign): the three post-analysis choices
 * are now IMPLEMENT / CONTINUE / SAVE.
 *  - implement: NO LONGER a continuation at all (C1, 2026-08-06). The reviewed
 *    plan → post-plan card → gated per-phase loop inside runCouncil owns
 *    implementation; feeding the raw synthesis back as prose was the measured
 *    defect (session 3a8378db4adf). `generate_plan` used to return the IDENTICAL
 *    string (a dead alias) and was removed outright 2026-08-04 — see
 *    docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md.
 *  - continue_session on analysis: STOP at the composer (return null). The
 *    synthesis is persisted as [Council Decision]/[Council Memory], so the user's
 *    next message inherits the council context — no wasteful re-present turn, no
 *    phantom-implementation drift. Only an implementation_plan debate still
 *    carries its original task forward (the /ideal build flow depends on it).
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

  it("continue_session on an analysis/evaluation debate STOPS at the composer (null)", () => {
    // The user chose to keep the session going without building. The council
    // context is persisted as system messages, so the next message inherits it —
    // no re-present turn is needed. null = stop.
    expect(postDebateContinuation("continue_session", EVAL_SYNTH)).toBeNull();
  });

  it("continue_session STOPS at the composer when the shape is unknown", () => {
    expect(postDebateContinuation("continue_session", PLAIN_SYNTH)).toBeNull();
  });

  it("explicit outputKind overrides the synthesis-derived kind", () => {
    // A plain-text synthesis but the caller knows the shape is an implementation plan.
    const p = postDebateContinuation("continue_session", PLAIN_SYNTH, "implementation_plan");
    expect(p).toContain("Continue the original task");
  });

  // C1 (2026-08-06) — this test used to assert the OPPOSITE: that "implement"
  // returns the synthesis wrapped in "Implement this now … approved spec" prose.
  // That is the defect, not the contract. runCouncil fired
  // onPostDebateAction("implement") BEFORE its own plan block ran and never
  // re-fired, so tool-engine.ts:852 built exactly this prose and ran it through
  // processMessage — a second, UNGATED implementation turn on the raw synthesis,
  // on top of the gated per-phase loop that had just executed the reviewed plan.
  // It fired identically after a verify HALT and after save_exit/Esc.
  //
  // The arm is deleted, not disabled. runCouncil now resolves "implement" to
  // `execute_plan` (the phase loop ran) or `save_exit` (nothing ran) before it
  // relays anything, so "implement" cannot reach this function from production
  // code at all. Asserting null here is the contract that keeps it that way: any
  // future caller that resurrects a prose implement handoff fails this test.
  // Seam coverage: src/council/__tests__/plan-execution-seam.test.ts.
  it("implement is NOT a prose handoff — the gated plan loop owns implementation now", () => {
    expect(postDebateContinuation("implement", EVAL_SYNTH)).toBeNull();
    expect(postDebateContinuation("implement", IMPL_SYNTH)).toBeNull();
    expect(postDebateContinuation("implement", IMPL_SYNTH, "implementation_plan")).toBeNull();
  });

  it("the terminal actions runCouncil now relays for an implement pick both stop", () => {
    // execute_plan → runPlanExecution already ran every phase inside runCouncil.
    // save_exit    → the plan is on disk and the user chose not to run it.
    expect(postDebateContinuation("execute_plan", IMPL_SYNTH, "implementation_plan")).toBeNull();
    expect(postDebateContinuation("save_exit", IMPL_SYNTH, "implementation_plan")).toBeNull();
  });

  it("generate_plan is a dead alias — it is dropped and returns null", () => {
    expect(postDebateContinuation("generate_plan", EVAL_SYNTH)).toBeNull();
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
