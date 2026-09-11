// The spend floor (VERDICT_FLOOR_*) and the cost-derived per-sprint message cap
// (MAX_VERDICT_* / PER_MESSAGE_COST_ESTIMATE_USD) were removed: `/ideal` — the
// only caller of the verdict resolver — has no spend cap (user decision). The
// resolver still ends on a verdict, on repeated leader/intent failures, or on
// DEFAULT_TIMEOUT_MS with nobody answering.

export const MAX_LEADER_FAILURES_BEFORE_FALLBACK = 3;
export const MAX_UNKNOWN_INTENT_BEFORE_FALLBACK = 5;

export const MAX_MESSAGES_PER_POLL = 50;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DISCORD_CONTENT_BUDGET = 1900;
