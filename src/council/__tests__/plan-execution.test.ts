import { describe, expect, it } from "vitest";
import { isCouncilPlanExecution, isImplementationIntent } from "../../pil/layer6-output.js";
import type { PlanPhase } from "../plan-artifact.js";
import { buildPhasePrompt, verifyPhase } from "../plan-execution.js";

const PHASE: PlanPhase = {
  id: "P0",
  title: "Sentinel E2E",
  steps: ["Add the spy"],
  files: ["src/council/index.ts"],
  acceptance: ["Sentinel wins end to end"],
  verify: "bunx vitest run x",
  done: false,
};

describe("execution envelope", () => {
  it("a phase prompt is recognised as council plan execution", () => {
    expect(isCouncilPlanExecution(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("a phase prompt also reads as implementation intent", () => {
    expect(isImplementationIntent(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("ordinary prose is not council plan execution", () => {
    expect(isCouncilPlanExecution("Council debate completed. Approved conclusion: …")).toBe(false);
  });

  it("the prompt carries the phase acceptance criteria and its verify command", () => {
    const p = buildPhasePrompt(".planning/PLAN.md", PHASE);
    expect(p).toContain("Sentinel wins end to end");
    expect(p).toContain("bunx vitest run x");
    expect(p).toContain("P0");
  });
});

describe("verifyPhase", () => {
  it("a zero exit status passes", () => {
    const r = verifyPhase(PHASE, "/tmp", () => ({ stdout: "ok", stderr: "", status: 0 }));
    expect(r.ok).toBe(true);
  });

  it("a non-zero exit status fails and keeps the output for the halt reason", () => {
    const r = verifyPhase(PHASE, "/tmp", () => ({ stdout: "", stderr: "2 failed", status: 1 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("2 failed");
  });

  it("a phase with no verify command does NOT auto-pass", () => {
    const r = verifyPhase({ ...PHASE, verify: "" }, "/tmp", () => ({ stdout: "", stderr: "", status: 0 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no verify command");
  });
});
