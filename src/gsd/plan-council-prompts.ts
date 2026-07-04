import type { CouncilContextBundle } from "./council-context.js";
import { renderCouncilContextBlock } from "./council-context.js";
import { VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";

export type PlanPerspectiveId = "architect" | "skeptic" | "research" | "security" | "implementer";

export interface PlanPerspective {
  id: PlanPerspectiveId;
  role: string;
  mandate: string;
}

export const PLAN_PERSPECTIVES: PlanPerspective[] = [
  {
    id: "architect",
    role: "architect",
    mandate: "Structural fit, file map correctness, dependency order, module boundaries.",
  },
  {
    id: "skeptic",
    role: "devil's advocate",
    mandate: "Challenge assumptions, missing edge cases, YAGNI violations, scope creep.",
  },
  {
    id: "research",
    role: "researcher",
    mandate: "Ground plan claims against codebase evidence (file:line citations required).",
  },
  {
    id: "security",
    role: "security reviewer",
    mandate: "Permission model, path traversal, secret handling, dangerous bash patterns in planned edits.",
  },
  {
    id: "implementer",
    role: "implementer",
    mandate: "Feasibility, estimate realism, testability of acceptance criteria.",
  },
];

export function perspectivesForDepth(depth: string): PlanPerspective[] {
  if (depth === "quick") return [];
  if (depth === "standard") {
    return PLAN_PERSPECTIVES.filter((p) => p.id === "research" || p.id === "skeptic");
  }
  return PLAN_PERSPECTIVES;
}

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
 * Build the debate topic fed to the council leader. Bundles prior GSD context
 * (discuss notes, research, acceptance criteria, prior concerns) with the
 * draft plan and the model-first output contract — the leader MUST end its
 * synthesis with a ```council-verdict fenced block; extraction falls back
 * conservatively when it doesn't.
 */
export function buildDebateTopic(planBody: string, bundle: CouncilContextBundle): string {
  return [
    "Review and debate the proposed plan to determine if it is complete, correct, safe, and optimal for the task.",
    "Debate the trade-offs, then converge on a single merged verdict.",
    "",
    renderCouncilContextBlock(bundle),
    "",
    "### Proposed PLAN.md:",
    planBody.trim(),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
