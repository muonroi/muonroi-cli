/**
 * src/orchestrator/compact-request.ts
 *
 * Process-global one-shot channel for an AGENT-initiated proactive compaction.
 *
 * The `compact` tool (src/tools/registry.ts) sets a pending request when the
 * model decides to free context mid-task; the tool-engine `prepareStep`
 * boundary consumes it exactly once and forces a compaction of the accumulated
 * tool/conversation history BEFORE the next LLM step, then continues the turn.
 * This is the proactive counterpart to the reactive tool-limit auto-recover
 * (tool-limit-auto-recover.ts): the agent no longer has to hit a round cap to
 * shed context — it can ask for a clean history the moment it judges the turn
 * has gone read-heavy, avoiding the interruption entirely.
 *
 * Single-active-turn assumption: the TUI streams one turn at a time, so a
 * process-global slot is sufficient and cannot cross-talk between concurrent
 * user turns. A nested sub-session runs within its parent's turn and consumes
 * the flag on its own next step — worst case a harmless extra compaction, never
 * data loss (compaction is snapshot + rehydratable via ee_query).
 */

export interface ProactiveCompactRequestState {
  /** Optional focus note the model wants preserved in mind after compaction. */
  instructions: string | null;
}

let pending: ProactiveCompactRequestState | null = null;

/**
 * STICKY focus, distinct from the one-shot `pending` above.
 *
 * `pending` is consumed exactly once (it *triggers* one compaction). The focus
 * the agent stated must outlive that consumption, because it has to reach TWO
 * different compaction paths that run at different times:
 *   - the per-step prepareStep compactor (`compactSubAgentMessages`), and
 *   - the summarizing compaction (`Orchestrator.compactForContext`), which runs
 *     outside the tool-loop closure entirely.
 * Before this existed, `consumeProactiveCompact()` in tool-engine.ts:2218 read
 * `instructions` and dropped it on the floor — the agent could say HOW to
 * compact and nothing read the answer.
 *
 * Scope is one user turn: `beginCompactionTurn()` is called at the turn
 * boundary in message-processor.ts. Last write wins within the turn.
 */
let focusNote: string | null = null;

/** Queue a proactive compaction to run before the next tool-loop step. */
export function requestProactiveCompact(instructions?: string | null): void {
  const trimmed = typeof instructions === "string" ? instructions.trim() : "";
  pending = { instructions: trimmed.length > 0 ? trimmed : null };
  // A bare `compact()` with no focus must NOT erase a focus stated earlier in
  // the same turn — the agent said it once and never retracted it.
  if (trimmed.length > 0) focusNote = trimmed;
}

/**
 * The most recent preservation focus the main-context agent stated this turn,
 * or null when it has not spoken. Read by both compaction paths.
 */
export function getCompactionFocus(): string | null {
  return focusNote;
}

/**
 * Turn boundary — drop the previous turn's focus so a stale "keep foo.ts open"
 * from turn 1 cannot shape a compaction in turn 9. Deliberately does NOT clear
 * `pending`: a request queued at the tail of a turn is still a real request.
 */
export function beginCompactionTurn(): void {
  focusNote = null;
}

/** True when a proactive compaction is queued (non-consuming peek). */
export function hasPendingProactiveCompact(): boolean {
  return pending !== null;
}

/** Consume the pending request exactly once (returns null when none queued). */
export function consumeProactiveCompact(): ProactiveCompactRequestState | null {
  const p = pending;
  pending = null;
  return p;
}

/** Test hook — clear any queued request. */
export function __resetProactiveCompactForTests(): void {
  pending = null;
  focusNote = null;
}
