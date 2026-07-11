/**
 * Single source of truth for the GSD plan-gate's EVALUATION AXES.
 *
 * The plan gate has two prompt paths — the interactive full-council debate
 * (`buildDebateTopic`) and the headless/offline perspective review
 * (`buildPerspectivePrompt` over `PLAN_PERSPECTIVES`). Both must judge a plan
 * against the SAME criteria, or the two gates drift: a plan the debate would
 * revise could pass headless (or vice-versa). The verdict *schema* is already
 * shared (`PlanCouncilVerdictSchema` + `VERDICT_OUTPUT_CONTRACT`); this module
 * closes the remaining gap by making the review CRITERIA a single constant both
 * builders derive from. A parity test locks it: drop or rename an axis and the
 * mismatch surfaces immediately.
 *
 * Council decision 2026-07-11 (multi-provider, research-grounded): unify the
 * gate's criteria vocabulary + verdict contract behind one source; keep both
 * paths (interactive debate + headless fallback) but stop them from diverging.
 */

export type PlanGateDimensionId = "correctness" | "structure" | "safety" | "grounding" | "feasibility";

export interface PlanGateDimension {
  id: PlanGateDimensionId;
  /** Short human label used in rendered prompt axes. */
  label: string;
  /** What a reviewer checks for this axis (drives both the debate topic and the perspective mandates). */
  probe: string;
}

/**
 * The canonical axes every plan is judged against — the union of what the
 * interactive debate ("complete, correct, safe, optimal") and the headless
 * perspectives (architect / skeptic / research / security / implementer)
 * historically evaluated, deduplicated into one list.
 */
export const PLAN_GATE_DIMENSIONS: readonly PlanGateDimension[] = [
  {
    id: "correctness",
    label: "Correct & complete",
    probe: "Every task has concrete steps and acceptance criteria; nothing essential is missing.",
  },
  {
    id: "structure",
    label: "Structural fit",
    probe: "File map is correct, dependency order is sound, module boundaries are respected.",
  },
  {
    id: "safety",
    label: "Safe",
    probe: "Permission model, path traversal, secret handling, and any planned bash are safe.",
  },
  {
    id: "grounding",
    label: "Grounded",
    probe: "Plan claims cite real codebase evidence (file:line), not assumptions.",
  },
  {
    id: "feasibility",
    label: "Feasible & optimal",
    probe: "Estimates are realistic and it is the simplest approach that works — no YAGNI or scope creep.",
  },
] as const;

/** Fast lookup by id. */
export const PLAN_GATE_DIMENSION_BY_ID: Readonly<Record<PlanGateDimensionId, PlanGateDimension>> = Object.fromEntries(
  PLAN_GATE_DIMENSIONS.map((d) => [d.id, d]),
) as Record<PlanGateDimensionId, PlanGateDimension>;

/**
 * Render the axes as a bullet list for a prompt. Both the debate topic and the
 * perspective prompt append this so a plan is judged against identical criteria
 * regardless of which gate path runs.
 */
export function renderGateAxes(): string {
  return [
    "The plan is judged against these axes:",
    ...PLAN_GATE_DIMENSIONS.map((d) => `- ${d.label}: ${d.probe}`),
  ].join("\n");
}
