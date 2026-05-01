/**
 * src/ee/prompt-stale.ts
 *
 * Per-turn prompt-stale reconciliation. Called fire-and-forget from PostToolUse
 * hook to report surfaced EE suggestions that the agent did not explicitly
 * acknowledge via feedback(). Uses "auto-compact" trigger to avoid cross-repo
 * server dependency (see 10-RESEARCH.md Pitfall 3).
 *
 * STALE-02: calls /api/prompt-stale for surfaced IDs
 * STALE-03: fire-and-forget — returns void, never blocks
 */

import { getDefaultEEClient, getLastSurfacedState, resetLastSurfacedState } from "./intercept.js";

/**
 * Fire-and-forget prompt-stale reconciliation.
 * Called from PostToolUse hook after each tool-use turn.
 *
 * Returns void — caller must NOT await (B-4 budget constraint).
 * Resets surfaced state BEFORE dispatching the async HTTP call
 * to prevent double-reporting on rapid sequential PostToolUse events.
 */
export function reconcilePromptStale(cwd: string, tenantId = "local"): void {
  const { surfacedIds, timestamp } = getLastSurfacedState();
  if (surfacedIds.length === 0) return;

  // Reset before async dispatch to avoid double-report (see 10-RESEARCH.md Pitfall 2)
  resetLastSurfacedState();

  getDefaultEEClient()
    .promptStale({
      state: { surfacedIds, timestamp },
      nextPromptMeta: { trigger: "auto-compact", cwd, tenantId },
    })
    .catch(() => {
      // Errors swallowed — fire-and-forget (B-4)
    });
}
