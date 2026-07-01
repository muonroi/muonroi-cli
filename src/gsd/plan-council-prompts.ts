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

export function buildPerspectivePrompt(perspective: PlanPerspective, planBody: string): string {
  return [
    `You are the ${perspective.role} on a plan review council.`,
    `Mandate: ${perspective.mandate}`,
    "Review the draft PLAN.md below. Return ONLY valid JSON:",
    '{ "verdict": "approve" | "revise" | "block", "concerns": string[], "evidence": string[] }',
    "",
    "--- PLAN.md ---",
    planBody,
    "--- END PLAN ---",
  ].join("\n");
}
