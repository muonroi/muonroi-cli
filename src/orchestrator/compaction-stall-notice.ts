/**
 * src/orchestrator/compaction-stall-notice.ts
 *
 * Round 4 (G8 HIGH) — "the compaction proposer stalled" notice for the
 * pre-stream setup phase.
 *
 * `compactForContext`'s proposer call (`compaction.ts`'s `proposeCompaction`)
 * is an `async function`, not a generator — it has no way to `yield` a toast
 * to the user directly. This is a simple module-level flag the CALLER
 * (tool-engine.ts's pre-stream compaction check, which IS a generator) polls
 * right after `await deps.compactForContext(...)` returns, so a stall that
 * was silently absorbed ("fall back gracefully, no compaction this turn")
 * is still surfaced to the user instead of just burning wall-clock time with
 * zero feedback — the same transparency gap `turn-progress.ts` fixed for the
 * watchdog's own idle timer, applied to the UI side of the same failure.
 *
 * Mirrors `turn-progress.ts`'s exact shape (a single last-value flag, no
 * queue — this fires at most once per compaction check, so there is nothing
 * to batch).
 */

let lastNotice: string | null = null;

/** Record that the compaction proposer stalled/timed out this attempt. */
export function markProposerStalled(message: string): void {
  lastNotice = message;
}

/** Read and CLEAR the pending notice, if any — at most once per stall. */
export function takeProposerStallNotice(): string | null {
  const n = lastNotice;
  lastNotice = null;
  return n;
}

/** Test-only: forget any pending notice. */
export function __resetProposerStallNoticeForTests(): void {
  lastNotice = null;
}
