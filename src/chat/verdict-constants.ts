export const VERDICT_FLOOR_MIN_USD = 0.1;
export const VERDICT_FLOOR_FRACTION = 0.01;

export const MAX_VERDICT_MESSAGES_BASE = 20;
export const MAX_VERDICT_FRACTION = 0.02;
export const PER_MESSAGE_COST_ESTIMATE_USD = 0.012;

export const MAX_LEADER_FAILURES_BEFORE_FALLBACK = 3;
export const MAX_UNKNOWN_INTENT_BEFORE_FALLBACK = 5;

export const MAX_MESSAGES_PER_POLL = 50;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DISCORD_CONTENT_BUDGET = 1900;

export function verdictFloor(capUsd: number): number {
  return Math.max(VERDICT_FLOOR_MIN_USD, VERDICT_FLOOR_FRACTION * capUsd);
}

export function maxVerdictMessages(capUsd: number): number {
  return Math.max(
    MAX_VERDICT_MESSAGES_BASE,
    Math.floor((MAX_VERDICT_FRACTION * capUsd) / PER_MESSAGE_COST_ESTIMATE_USD),
  );
}
