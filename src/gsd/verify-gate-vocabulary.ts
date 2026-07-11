/**
 * Single source of truth for the GSD verify-gate's EVALUATION AXES — the twin of
 * plan-gate-vocabulary.ts for the verify council. Same drift risk: the interactive
 * verify debate (`buildVerifyDebateTopic`) and the headless perspective review
 * (`buildVerifyPerspectivePrompt` over `VERIFY_PERSPECTIVES`) must judge an
 * implementation against IDENTICAL criteria or the two verify gates diverge.
 *
 * Council decision 2026-07-11 (PR 2): apply the plan-gate consolidation to the
 * verify twin — one criteria source both paths derive from, parity-locked.
 */

export type VerifyGateDimensionId = "acceptance" | "correctness" | "regression" | "safety";

export interface VerifyGateDimension {
  id: VerifyGateDimensionId;
  label: string;
  probe: string;
}

/**
 * The canonical axes every implementation is judged against once the
 * deterministic test floor has passed — intent-vs-reality, not "tests are green".
 */
export const VERIFY_GATE_DIMENSIONS: readonly VerifyGateDimension[] = [
  {
    id: "acceptance",
    label: "Acceptance met",
    probe: "Every acceptance criterion is satisfied by a cited diff line or concrete evidence.",
  },
  {
    id: "correctness",
    label: "Actually correct",
    probe: "No concrete failing input or state refutes that the implementation works.",
  },
  {
    id: "regression",
    label: "No regression",
    probe: "No behavior outside the task scope was broken — no removed guards, changed signatures, or side effects.",
  },
  {
    id: "safety",
    label: "Safe",
    probe: "The diff introduces no path traversal, secret leak, permission change, or dangerous shell pattern.",
  },
] as const;

/** Fast lookup by id. */
export const VERIFY_GATE_DIMENSION_BY_ID: Readonly<Record<VerifyGateDimensionId, VerifyGateDimension>> =
  Object.fromEntries(VERIFY_GATE_DIMENSIONS.map((d) => [d.id, d])) as Record<
    VerifyGateDimensionId,
    VerifyGateDimension
  >;

/** Bullet list of axes, shared by both verify-gate prompt paths. */
export function renderVerifyGateAxes(): string {
  return [
    "The implementation is judged against these axes (the test floor already passed):",
    ...VERIFY_GATE_DIMENSIONS.map((d) => `- ${d.label}: ${d.probe}`),
  ].join("\n");
}
