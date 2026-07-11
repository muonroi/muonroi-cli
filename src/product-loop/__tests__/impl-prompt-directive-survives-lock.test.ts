import { describe, expect, it } from "vitest";
import { prependDecisionsLock } from "../../council/decisions-lock.js";
import { isSprintPlanExecution, SPRINT_EXECUTION_MARKER } from "../../pil/layer6-output.js";
import { IMPL_EXECUTION_DIRECTIVE } from "../sprint-runner.js";

// Regression for the 2026-07-08 C2 pre-impl gate bug: the decisions.lock
// prepend was applied to the bare planSynthesis, silently dropping
// IMPL_EXECUTION_DIRECTIVE (+ SPRINT_EXECUTION_MARKER). Every council-backed
// sprint (a lock always exists once the council ran) then reached the
// orchestrator as a bare design doc → the impl turn narrated instead of
// executing, classified taskType=null (4_096 cap), and wedged on
// finishReason:"length". The assembled prompt MUST keep the marker so the PIL
// classifier routes to the implement/edit path and the output budget floors to
// the build tier.
describe("sprint impl prompt keeps its execution directive through the decisions-lock gate", () => {
  const planSynthesis = "## Agreed Architecture\n\nBuild src/council-workflow/registry.ts ...";
  const lockContent = "# Locked Decisions — Run xyz\n\n## Stack\n- Frontend: React";

  it("IMPL_EXECUTION_DIRECTIVE alone is a sprint-execution prompt", () => {
    const implPrompt = IMPL_EXECUTION_DIRECTIVE + planSynthesis;
    expect(implPrompt).toContain(SPRINT_EXECUTION_MARKER);
    expect(isSprintPlanExecution(implPrompt)).toBe(true);
  });

  it("prepending the lock to the DIRECTIVE-carrying prompt PRESERVES the marker (fixed path)", () => {
    const implPrompt = IMPL_EXECUTION_DIRECTIVE + planSynthesis;
    const withLock = prependDecisionsLock(implPrompt, lockContent);
    expect(withLock).toContain("## Locked decisions you MUST follow");
    expect(withLock).toContain(SPRINT_EXECUTION_MARKER);
    expect(isSprintPlanExecution(withLock)).toBe(true); // the invariant that was broken
  });

  it("prepending the lock to the BARE planSynthesis LOSES the marker (the original bug — guards against regressing)", () => {
    const buggy = prependDecisionsLock(planSynthesis, lockContent);
    expect(isSprintPlanExecution(buggy)).toBe(false);
  });
});
