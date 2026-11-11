/**
 * Single source of truth for the FLOW verify-gate's EVALUATION AXES — the twin of
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

/**
 * Judgment rules shared by both verify-gate prompt paths (rendered after the axes).
 *
 * Session 26516fe0c62e (convert an HTML export to markdown): every layer checked counts copied from
 * the plan and passed output that still escaped identifiers (`tenant\_id`) and left entities inside
 * code spans, because nothing compared the deliverable with its SOURCE. The same run's verify #2
 * failed on a side notes file outside the done-criteria while those defects went unflagged. These
 * rules cover both: fidelity evidence for transformations, and scope-weighted concerns.
 */
export function renderVerifyGateRules(): string {
  return [
    "Transformation deliverables (the root goal converts, migrates, ports, translates or extracts an input into another form):",
    "- Counts, totals and absence-of-marker checks taken from the plan (items, headings, blocks, no leftover tags) are NOT sufficient evidence by themselves; output can match every count and still be wrong.",
    "- Require evidence that sampled passages of the SOURCE appear in the OUTPUT with equivalent normalized text: the sample covers prose, code/literal spans, identifiers and special characters, and shows escaping, entities and identifier spelling preserved (a name present in the source must be found verbatim wherever the output is searched or parsed).",
    "- If the evidence shows only counts or format checks, raise a blocking concern asking for a source-vs-output sample comparison; do not approve on counts alone.",
    "Scope of concerns:",
    '- Weigh every concern against the root goal\'s stated done-criteria. A concern about an artifact outside the deliverable and the done-criteria (notes, inventories, scratch files, process documentation) is advisory: report it as a finding with severity "advisory" and do NOT let it alone drive a revise or block verdict.',
    "- It stays blocking when it shows the deliverable itself is wrong, or when a claim in the supplied evidence is false (for example a measured count that does not match the real one).",
  ].join("\n");
}
