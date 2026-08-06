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

  it("a revise verdict still offers execute_plan (a lone parse-failure reviewer forces revise) but does not default to it", () => {
    // mergeReviewVerdicts is severity-wins: one reviewer whose output fails
    // extractStructuredVerdict is recorded as "revise" with a synthetic concern,
    // which is enough to force the merged verdict to "revise" even when nobody
    // raised a substantive objection. A retry-exhausted revise must still have a
    // forward path — block is the only verdict with no execute option.
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "revise", concerns: ["needs work"] });
    expect(card.options.some((o) => o.value === "execute_plan")).toBe(true);
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

  it("an approved plan labels its concerns as notes, not dissent", () => {
    // mergeReviewVerdicts flattens concerns from EVERY reviewer, including
    // approving ones, so an "approve" verdict can still carry a non-empty
    // concerns array. The card must not present these as unresolved objections
    // on an approved plan — assert the actual label the builder emits, not just
    // the absence of words it happens not to use elsewhere either.
    const card = buildPostPlanCard({
      planPath: "p",
      phases: PHASES,
      verdict: "approve",
      concerns: ["consider adding a rollback step"],
    });
    expect(card.context).toContain("Notes from review");
    expect(card.context).not.toContain("Concerns from review");
    expect(card.context).toContain("consider adding a rollback step");
  });

  it("a non-approved plan labels its concerns as concerns, not notes", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "block", concerns: ["unsafe"] });
    expect(card.context).toContain("Concerns from review");
    expect(card.context).not.toContain("Notes from review");
  });

  // ── I4: the card must show the shell commands it is authorising ───────────
  describe("verify commands are on the consent card (I4)", () => {
    const WITH_VERIFY: PlanPhase[] = [
      { id: "P0", title: "a", steps: [], files: [], acceptance: ["x"], verify: "bunx vitest run src/a", done: false },
      {
        id: "P1",
        title: "b",
        steps: [],
        files: [],
        acceptance: ["y"],
        verify: "rm -rf dist && bun run build",
        done: false,
      },
    ];

    it("renders each phase's verify command verbatim", () => {
      // Picking execute authorises spawn(cmd, [], { cwd, shell: true }) of an
      // LLM-authored string, once per phase (plan-execution.ts:85). This card is
      // the consent gate, so the commands consented to must be readable on it.
      const card = buildPostPlanCard({ planPath: "p", phases: WITH_VERIFY, verdict: "approve", concerns: [] });
      expect(card.context).toContain("bunx vitest run src/a");
      expect(card.context).toContain("rm -rf dist && bun run build");
    });

    it("says so explicitly when a phase has NO verify command", () => {
      // Not an omission to hide: verifyPhase FAILS a command-less phase rather
      // than passing it, so this changes what the user is agreeing to.
      const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
      expect(card.context).toContain("cannot be gated");
    });

    it("warns that the commands run in a shell", () => {
      const card = buildPostPlanCard({ planPath: "p", phases: WITH_VERIFY, verdict: "approve", concerns: [] });
      const exec = card.options.find((o) => o.value === "execute_plan");
      expect(exec?.description).toMatch(/shell/i);
    });
  });

  // ── I9: don't sell an execute that the mutation gate will silently eat ────
  describe("execute is withdrawn when the GSD mutation gate would block it (I9)", () => {
    it("a revise verdict under a blocking gate offers NO execute_plan", () => {
      // canExecute (workflow-engine.ts:227-243) blocks every mutation tool at
      // heavy depth while PLAN-VERIFY.md is not `pass`. runPlanReview wrote
      // `revise` there, so the phases would run, write nothing, fail their own
      // verify and halt at P0 — after paying for a full agent turn each.
      const card = buildPostPlanCard({
        planPath: "p",
        phases: PHASES,
        verdict: "revise",
        concerns: ["needs work"],
        gateBlocksExecution: true,
      });
      expect(card.options.some((o) => o.value === "execute_plan")).toBe(false);
      expect(card.options[card.defaultIndex].value).toBe("revise_plan");
    });

    it("says WHY execute is missing rather than silently dropping the option", () => {
      const card = buildPostPlanCard({
        planPath: "p",
        phases: PHASES,
        verdict: "revise",
        concerns: [],
        gateBlocksExecution: true,
      });
      expect(card.context).toContain("Execute is unavailable");
      expect(card.context).toContain("PLAN-VERIFY.md");
      expect(card.question).toMatch(/mutation gate/i);
    });

    it("gateBlocksExecution:false leaves the deliberate revise->execute path intact", () => {
      const card = buildPostPlanCard({
        planPath: "p",
        phases: PHASES,
        verdict: "revise",
        concerns: [],
        gateBlocksExecution: false,
      });
      expect(card.options.some((o) => o.value === "execute_plan")).toBe(true);
    });

    it("an APPROVED plan is unaffected (the gate passes on a `pass` verdict)", () => {
      const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
      expect(card.options[card.defaultIndex].value).toBe("execute_plan");
      expect(card.context).not.toContain("Execute is unavailable");
    });
  });
});
