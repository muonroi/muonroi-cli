import { renderCouncilContextBlock } from "./council-context.js";
import { VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";
import type { VerifyContextBundle } from "./verify-context.js";
import { renderVerifyGateAxes, renderVerifyGateRules, type VerifyGateDimensionId } from "./verify-gate-vocabulary.js";

export type VerifyPerspectiveId = "acceptance" | "correctness" | "regression" | "security";

export interface VerifyPerspective {
  id: VerifyPerspectiveId;
  role: string;
  mandate: string;
  /**
   * The shared verify-gate axis this perspective primarily owns. Ties the
   * headless perspective set to the same criteria the interactive verify debate
   * uses; the full set must cover every VERIFY_GATE_DIMENSION (parity-tested).
   */
  dimension: VerifyGateDimensionId;
}

export const VERIFY_PERSPECTIVES: VerifyPerspective[] = [
  {
    id: "acceptance",
    role: "acceptance auditor",
    mandate:
      "For EACH acceptance criterion, cite the diff line or evidence that satisfies it. Any criterion without concrete evidence is a concern.",
    dimension: "acceptance",
  },
  {
    id: "correctness",
    role: "adversarial correctness reviewer",
    mandate:
      "Try to REFUTE that the implementation works. Construct a concrete failing input or state. Default to a concern when uncertain.",
    dimension: "correctness",
  },
  {
    id: "regression",
    role: "regression reviewer",
    mandate:
      "Identify behavior OUTSIDE the task scope that the diff may have broken (removed guards, changed signatures, side effects).",
    dimension: "regression",
  },
  {
    id: "security",
    role: "security reviewer",
    mandate: "Path traversal, secret handling, permission changes, dangerous shell patterns introduced by the diff.",
    dimension: "safety",
  },
];

/** standard = acceptance + correctness; heavy = all four; quick = none (deterministic floor only). */
export function verifyPerspectivesForDepth(depth: string): VerifyPerspective[] {
  if (depth === "quick") return [];
  if (depth === "standard") return VERIFY_PERSPECTIVES.filter((p) => p.id === "acceptance" || p.id === "correctness");
  return VERIFY_PERSPECTIVES;
}

/**
 * Rendered in place of the diff block when the filtered diff is empty. A plan whose deliverable is an
 * answer or report (read-only analysis) changes no files; demanding a diff would make it unpassable.
 */
export const NO_DIFF_DELIVERABLE_SECTION = [
  "### No implementation diff (analysis / report deliverable)",
  "",
  "This plan changed no files in the repository. That is EXPECTED for an analysis, research or report",
  "deliverable, whose product is the answer itself, not a code change. The absence of a diff, and the",
  "absence of any repo file embedding the results, is NOT a concern by itself.",
  "Judge acceptance against the verification evidence above instead: the cited checks, job ids and",
  "re-read results. A criterion is unmet only when that evidence fails to support it or contradicts it.",
  "Do not raise concerns about planning-state files or placeholder phase entries written by the FLOW host.",
].join("\n");

function renderBundle(bundle: VerifyContextBundle): string {
  const diffSection = bundle.diff.trim()
    ? ["### Implementation diff under review", "", "```diff", bundle.diff, "```"].join("\n")
    : NO_DIFF_DELIVERABLE_SECTION;
  return [
    renderCouncilContextBlock(bundle.base),
    "",
    "### Deterministic-floor evidence (tests/lint/self-verify)",
    "",
    bundle.evidence || "(no evidence supplied)",
    "",
    ...(bundle.hostEvidence
      ? [
          "### Host-recorded worker evidence",
          "",
          "Collected by the host from this run's finished workers (newest first), independent of main's summary above. A criterion is supported when this evidence shows it, even if main's summary omits it; it is a worker's report, so weigh it against the plan and the diff.",
          "",
          bundle.hostEvidence,
          "",
        ]
      : []),
    diffSection,
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
    // Shared gate axes (single source with the interactive verify debate) so both
    // verify-gate paths judge the implementation against identical criteria.
    renderVerifyGateAxes(),
    "",
    renderVerifyGateRules(),
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
    // Shared gate axes (single source with the headless perspective review) so
    // both verify-gate paths judge the implementation against identical criteria.
    renderVerifyGateAxes(),
    "",
    renderVerifyGateRules(),
    "",
    renderBundle(bundle),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
