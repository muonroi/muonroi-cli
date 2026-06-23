/**
 * src/pil/layer18-acceptance.ts
 *
 * Phase 3 (2026-06-23): acceptance is now model-driven — the model includes
 * acceptance/rejection options in its own ModelCard[]. The CLI no longer
 * builds hardcoded Accept/Adjust/Cancel buttons.
 *
 * What remains here is a simplified summary card builder used by the
 * `showAcceptance` replacement: when feasibility warnings exist, the CLI
 * appends them as context to the model's last card rather than creating a
 * separate acceptance ceremony.
 */
import type { AcceptanceCardData, ClarifiedIntent, FeasibilityResult } from "./discovery-types.js";

export function buildAcceptanceCard(
  intentStatement: string,
  intent: ClarifiedIntent,
  feasibility: FeasibilityResult,
  raw?: string,
): AcceptanceCardData {
  const warnings = [...feasibility.warnings];

  return {
    intentStatement,
    outcome: intent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : intent.scope,
    warnings,
  };
}
