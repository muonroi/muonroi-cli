// ---------------------------------------------------------------------------
// Shared /ideal product-loop defaults.
// ---------------------------------------------------------------------------
// Single source of truth for the loop settings applied when `/ideal` starts with
// no explicit flags. Consumed by the slash parser (src/ui/slash/ideal.ts) AND
// the two programmatic entry points (orchestrator ENTER_IDEAL route + the
// enter_ideal tool's post-turn dispatch), so the three paths cannot drift.
//
// There is deliberately NO spend cap and NO sprint ceiling here. `/ideal` has no
// limits of any kind — the user's decision, their model usage is sponsored. A run
// ends when the Definition of Done is met or when sprints stop making progress
// (src/product-loop/sprint-progress.ts). An explicit `--max-sprints N` the user
// types is still honoured as a ceiling they asked for.
//
// A leaf module (no heavy imports) so a static import does not eager-load the
// product-loop index.
// ---------------------------------------------------------------------------

/** Default settings for a fresh `/ideal` start. */
export const IDEAL_LOOP_DEFAULTS = {
  doneThreshold: 0.9,
} as const;
