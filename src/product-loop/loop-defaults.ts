// ---------------------------------------------------------------------------
// Shared /ideal product-loop budget defaults.
// ---------------------------------------------------------------------------
// Single source of truth for the loop budget applied when `/ideal` starts with
// no explicit flags. Consumed by the slash parser (src/ui/slash/ideal.ts) AND
// the two programmatic entry points (orchestrator ENTER_IDEAL route + the
// enter_ideal tool's post-turn dispatch), so the three paths cannot drift.
//
// A leaf module (no heavy imports) so a static import does not eager-load the
// product-loop index.
// ---------------------------------------------------------------------------

/** Default loop budget for a fresh `/ideal` start. */
export const IDEAL_LOOP_DEFAULTS = {
  maxCost: 50,
  maxSprints: 8,
  doneThreshold: 0.9,
} as const;
