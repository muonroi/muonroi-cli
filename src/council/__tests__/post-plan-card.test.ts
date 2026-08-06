import { describe, expect, it } from "vitest";
import { buildPostPlanCard } from "../index.js";
import type { PlanPhase } from "../plan-artifact.js";

const PHASES: PlanPhase[] = [
  { id: "P0", title: "a", steps: [], files: [], acceptance: ["x"], verify: "", done: false },
  { id: "P1", title: "b", steps: [], files: [], acceptance: ["y"], verify: "", done: false },
];

describe("buildPostPlanCard", () => {
  it("reports the plan path and every phase", () => {
    const card = buildPostPlanCard({ planPath: ".planning/PLAN.md", phases: PHASES, verdict: "approve", concerns: [] });
    expect(card.context).toContain(".planning/PLAN.md");
    expect(card.context).toContain("P0");
    expect(card.context).toContain("P1");
  });

  it("an approved plan defaults to executing the whole plan", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
    expect(card.options[card.defaultIndex].value).toBe("execute_plan");
  });

  it("a blocked plan offers no execute option and surfaces the concerns", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "block", concerns: ["unsafe"] });
    expect(card.options.some((o) => o.value === "execute_plan")).toBe(false);
    expect(card.context).toContain("unsafe");
  });

  it("a blocked plan defaults to revise_plan since execute_plan is absent", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "block", concerns: ["unsafe"] });
    expect(card.options[card.defaultIndex].value).toBe("revise_plan");
  });

  it("a revise verdict also omits execute_plan and defaults to revise_plan", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "revise", concerns: ["needs work"] });
    expect(card.options.some((o) => o.value === "execute_plan")).toBe(false);
    expect(card.options[card.defaultIndex].value).toBe("revise_plan");
  });

  it("every phase line reports its acceptance-criteria count", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
    // P0 carries 1 acceptance criterion ("x"), P1 carries 1 ("y").
    expect(card.context).toMatch(/P0[^\n]*1 acceptance/);
    expect(card.context).toMatch(/P1[^\n]*1 acceptance/);
  });

  it("revise_plan is a freetext option so the user's comments re-enter the planner", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
    const revise = card.options.find((o) => o.value === "revise_plan");
    expect(revise?.kind).toBe("freetext");
  });

  it("always offers save_exit regardless of verdict", () => {
    for (const verdict of ["approve", "revise", "block"] as const) {
      const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict, concerns: [] });
      expect(card.options.some((o) => o.value === "save_exit")).toBe(true);
    }
  });

  it("reports the verdict in the context", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
    expect(card.context.toLowerCase()).toContain("approve");
  });

  it("an approved plan whose concerns came only from approving reviewers are not framed as dissent", () => {
    // mergeReviewVerdicts flattens concerns from EVERY reviewer, including
    // approving ones, so an "approve" verdict can still carry a non-empty
    // concerns array. The card must not present these as unresolved objections
    // on an approved plan.
    const card = buildPostPlanCard({
      planPath: "p",
      phases: PHASES,
      verdict: "approve",
      concerns: ["consider adding a rollback step"],
    });
    expect(card.context).not.toMatch(/unresolved concern|blocking concern|dissent/i);
    expect(card.context).toContain("consider adding a rollback step");
  });
});
