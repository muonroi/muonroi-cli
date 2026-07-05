import { renderCouncilContextBlock } from "./council-context.js";
import { VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";
import type { VerifyContextBundle } from "./verify-context.js";

export type VerifyPerspectiveId = "acceptance" | "correctness" | "regression" | "security";

export interface VerifyPerspective {
  id: VerifyPerspectiveId;
  role: string;
  mandate: string;
}

export const VERIFY_PERSPECTIVES: VerifyPerspective[] = [
  {
    id: "acceptance",
    role: "acceptance auditor",
    mandate:
      "For EACH acceptance criterion, cite the diff line or evidence that satisfies it. Any criterion without concrete evidence is a concern.",
  },
  {
    id: "correctness",
    role: "adversarial correctness reviewer",
    mandate:
      "Try to REFUTE that the implementation works. Construct a concrete failing input or state. Default to a concern when uncertain.",
  },
  {
    id: "regression",
    role: "regression reviewer",
    mandate:
      "Identify behavior OUTSIDE the task scope that the diff may have broken (removed guards, changed signatures, side effects).",
  },
  {
    id: "security",
    role: "security reviewer",
    mandate: "Path traversal, secret handling, permission changes, dangerous shell patterns introduced by the diff.",
  },
];

/** standard = acceptance + correctness; heavy = all four; quick = none (deterministic floor only). */
export function verifyPerspectivesForDepth(depth: string): VerifyPerspective[] {
  if (depth === "quick") return [];
  if (depth === "standard") return VERIFY_PERSPECTIVES.filter((p) => p.id === "acceptance" || p.id === "correctness");
  return VERIFY_PERSPECTIVES;
}

function renderBundle(bundle: VerifyContextBundle): string {
  return [
    renderCouncilContextBlock(bundle.base),
    "",
    "### Deterministic-floor evidence (tests/lint/self-verify)",
    "",
    bundle.evidence || "(no evidence supplied)",
    "",
    "### Implementation diff under review",
    "",
    "```diff",
    bundle.diff || "(no diff supplied)",
    "```",
  ].join("\n");
}

export function buildVerifyPerspectivePrompt(p: VerifyPerspective, bundle: VerifyContextBundle): string {
  return [
    `You are the ${p.role} on a verify council judging whether an implementation meets its plan.`,
    `Mandate: ${p.mandate}`,
    "",
    "The deterministic test floor has already PASSED. Your job is intent-vs-reality: does the code",
    "actually achieve the plan's goal and acceptance criteria? Tests passing is necessary, not sufficient.",
    "",
    renderBundle(bundle),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}

export function buildVerifyDebateTopic(bundle: VerifyContextBundle): string {
  return [
    "Debate whether the implementation below satisfies the plan's goal and acceptance criteria.",
    "The deterministic test floor already passed — focus on goal-achievement, missed acceptance criteria,",
    "and regressions. Converge on a single merged verdict.",
    "",
    renderBundle(bundle),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
