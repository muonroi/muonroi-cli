/**
 * src/orchestrator/sub-session-resume.ts
 *
 * Round 4 (G9): whether a NEW request should RESUME an active background
 * sub-session, or the request is a genuinely different task and a fresh
 * sub-session should be forked instead.
 *
 * Root cause this replaces: the SPAWN_SUB_SESSION handler in orchestrator.ts
 * used to decide resume-vs-fork purely by RECENCY — any active sub-session
 * less than 15 minutes old was resumed unconditionally, with zero check of
 * whether the new request had anything to do with what that sub-session was
 * actually working on. Measured live (session 69e68c766fcf): an unrelated
 * "tìm repo Python mới và dựng bài tới hết stage0" (hunt/stage0) request
 * resumed sub-session 74ce4cbd7266 — the OLD "seal challenge
 * precommit-working-set-drift" sub-session and its 29-message context — so
 * the new task ran inside a completely wrong conversation.
 *
 * Extracted as a pure, directly-testable decision — the real call site
 * (orchestrator.ts's SPAWN_SUB_SESSION handler) also touches the real
 * SQLite DB and the real LLM classifier, neither of which is needed to test
 * THIS decision in isolation.
 */

export interface SubSessionResumeDecision {
  resume: boolean;
  reason: string;
}

export interface SubSessionRelatednessVerdict {
  related: boolean;
  reason?: string;
}

/**
 * Fail-CLOSED throughout: every path that cannot POSITIVELY confirm "this
 * is the same task" returns `resume: false` (fork fresh) rather than
 * defaulting to the old resume-unconditionally behaviour. Forking fresh is
 * always safe — worst case is a little redundant setup; blindly resuming an
 * unrelated context is the bug being fixed here.
 */
export async function shouldResumeSubSession(opts: {
  /** Minutes since the active sub-session was last touched. */
  diffMins: number;
  /** The active sub-session's own recorded goal/title, if one was recorded. */
  activeGoal: string | null;
  /** The NEW user request driving this turn. */
  newRequest: string;
  /**
   * LLM relatedness classifier — injected so this stays testable without a
   * real model call. Mirrors `classifySubSessionAction`'s own
   * fail-on-error-returns-null contract.
   */
  classify: (newRequest: string, activeGoal: string) => Promise<SubSessionRelatednessVerdict | null>;
}): Promise<SubSessionResumeDecision> {
  if (opts.diffMins > 15) {
    return { resume: false, reason: `stale (${opts.diffMins.toFixed(1)} min since last update)` };
  }
  if (!opts.activeGoal?.trim()) {
    // No recorded goal to compare against — cannot verify relatedness, so do
    // not blindly resume an unverified context.
    return { resume: false, reason: "active sub-session has no recorded goal to compare against" };
  }

  const verdict = await opts.classify(opts.newRequest, opts.activeGoal);
  if (!verdict) {
    return { resume: false, reason: "relatedness classification failed — failing closed (fork fresh)" };
  }
  if (!verdict.related) {
    return { resume: false, reason: verdict.reason ?? "unrelated task" };
  }
  return { resume: true, reason: verdict.reason ?? "related — resuming" };
}
