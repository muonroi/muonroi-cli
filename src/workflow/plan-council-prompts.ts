import type { CouncilContextBundle } from "./council-context.js";
import { renderCouncilContextBlock } from "./council-context.js";
import { type PlanGateDimensionId, renderGateAxes } from "./plan-gate-vocabulary.js";
import { VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";

export type PlanPerspectiveId = "architect" | "skeptic" | "research" | "security" | "implementer";

export interface PlanPerspective {
  id: PlanPerspectiveId;
  role: string;
  mandate: string;
  /**
   * The shared gate axis this perspective primarily owns. Ties the headless
   * perspective set to the same criteria the interactive debate uses; the full
   * perspective set must cover every PLAN_GATE_DIMENSION (parity-tested).
   */
  dimension: PlanGateDimensionId;
}

export const PLAN_PERSPECTIVES: PlanPerspective[] = [
  {
    id: "architect",
    role: "architect",
    mandate: "Structural fit, file map correctness, dependency order, module boundaries.",
    dimension: "structure",
  },
  {
    id: "skeptic",
    role: "devil's advocate",
    mandate: "Challenge assumptions, missing edge cases, YAGNI violations, scope creep.",
    dimension: "feasibility",
  },
  {
    id: "research",
    role: "researcher",
    mandate: "Ground plan claims against codebase evidence (file:line citations required).",
    dimension: "grounding",
  },
  {
    id: "security",
    role: "security reviewer",
    mandate: "Permission model, path traversal, secret handling, dangerous bash patterns in planned edits.",
    dimension: "safety",
  },
  {
    id: "implementer",
    role: "implementer",
    mandate: "Feasibility, estimate realism, testability of acceptance criteria.",
    dimension: "correctness",
  },
];

export function perspectivesForDepth(depth: string): PlanPerspective[] {
  if (depth === "quick") return [];
  if (depth === "standard") {
    return PLAN_PERSPECTIVES.filter((p) => p.id === "research" || p.id === "skeptic");
  }
  return PLAN_PERSPECTIVES;
}

export const PLAN_REVIEW_CONVERGENCE = `Review convergence and authority:
- Judge the user's existing goal and acceptance criteria. On revisions, first mark each prior concern resolved or still open with current evidence; do not relitigate a resolved concern without new concrete evidence.
- A new blocking concern must identify a material correctness, safety or acceptance failure. Keep optional enhancements in rationale; do not silently add an artifact framework, exhaustive-proof requirement or broader deliverable to a bounded task.
- This is plan admission, not completed implementation verification. A concrete preflight with observable checks and a stop-on-failure branch is a valid planned step; never pretend it already executed or demand all implementation evidence before permitting that step.
- Main only coordinates. Never require main to run commands, edit files or redo a worker's work. Require host-collected, version-bound independent worker evidence where execution proof is needed; worker prose alone is not execution evidence.
- Respect honest measurement and isolation limits. Record remaining blind spots and assess their actual effect against the user's requirements instead of demanding universal guarantees.
- Approve only when the required criteria are satisfied. Genuine unresolved blockers remain revise/block. A review resource limit never grants approval; when reached, stop and report the unresolved concerns.`;

export function buildPerspectivePrompt(
  perspective: PlanPerspective,
  planBody: string,
  bundle?: CouncilContextBundle,
): string {
  const lines = [`You are the ${perspective.role} on a plan review council.`, `Mandate: ${perspective.mandate}`];
  if (bundle) {
    lines.push("", renderCouncilContextBlock(bundle, { forPerspective: perspective.id }));
  }
  lines.push(
    "",
    // Shared gate axes (single source with the interactive debate) so headless
    // and interactive reviews judge the plan against identical criteria.
    renderGateAxes(),
    PLAN_REVIEW_CONVERGENCE,
    "",
    "Review the draft PLAN.md below, then emit your structured verdict.",
    VERDICT_OUTPUT_CONTRACT,
    "",
    "--- PLAN.md ---",
    planBody,
    "--- END PLAN ---",
  );
  return lines.join("\n");
}

/**
 * Build the debate topic fed to the council leader. Bundles prior FLOW context
 * (discuss notes, research, acceptance criteria, prior concerns) with the
 * draft plan and the model-first output contract — the leader MUST end its
 * synthesis with a ```council-verdict fenced block; extraction falls back
 * conservatively when it doesn't.
 */
export function buildDebateTopic(planBody: string, bundle: CouncilContextBundle): string {
  return [
    "Review the proposed plan against the user's acceptance and safety criteria for execution. Optional optimization is advisory.",
    "Debate the trade-offs, then converge on a single merged verdict.",
    "",
    // Shared gate axes (single source with the headless perspective review) so
    // both gate paths judge the plan against identical criteria — no drift.
    renderGateAxes(),
    PLAN_REVIEW_CONVERGENCE,
    "",
    renderCouncilContextBlock(bundle),
    "",
    "### Proposed PLAN.md:",
    planBody.trim(),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
