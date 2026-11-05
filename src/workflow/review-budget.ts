import { loadConfig, resolveConfigKey } from "./config-loader.js";

/** Host-owned resource allowance for one user request, shared across SDK retries. */
export interface PlanReviewBudget {
  used: number;
  max: number;
  stopRequested?: boolean;
}

/**
 * What the host does when plan review stops converging (allowance spent or the
 * reviewer keeps the same blocking objection open round after round).
 *  - `proceed`: admit the best plan; unresolved blocking findings stay OPEN in the
 *    ledger and are carried into execution/verification as open items.
 *  - `stop`: end the tool loop and report (the pre-2026-11 behaviour).
 */
export type PlanReviewExhaustionPolicy = "proceed" | "stop";

/** Documented default round allowance when neither env nor planning config sets one. */
export const DEFAULT_PLAN_REVIEW_ROUNDS = 3;
const MAX_PLAN_REVIEW_ROUNDS = 20;
export const DEFAULT_PLAN_REVIEW_EXHAUSTION_POLICY: PlanReviewExhaustionPolicy = "proceed";

function parseRounds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_PLAN_REVIEW_ROUNDS) : undefined;
}

/**
 * Round allowance for plan review. Precedence: env
 * `MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS` → planning config
 * `workflow.plan_review_max_rounds` (`.planning/config.json`) → 3.
 * Depth only decides WHETHER review runs (quick skips it); it never selects a
 * round count — no depth→count table (see feedback_no_hardcode_routing).
 */
export function resolvePlanReviewRounds(cwd?: string): number {
  const fromEnv = parseRounds(process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS);
  if (fromEnv !== undefined) return fromEnv;
  if (cwd) {
    const { found, value } = resolveConfigKey("workflow.plan_review_max_rounds", loadConfig(cwd));
    const fromConfig = found ? parseRounds(value) : undefined;
    if (fromConfig !== undefined) return fromConfig;
  }
  return DEFAULT_PLAN_REVIEW_ROUNDS;
}

/**
 * Exhaustion policy. Precedence: env `MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION` →
 * planning config `workflow.plan_review_on_exhaustion` → `proceed`.
 */
export function resolvePlanReviewExhaustionPolicy(cwd?: string): PlanReviewExhaustionPolicy {
  const parse = (v: unknown): PlanReviewExhaustionPolicy | undefined =>
    v === "proceed" || v === "stop" ? v : undefined;
  const fromEnv = parse(process.env.MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION?.trim().toLowerCase());
  if (fromEnv) return fromEnv;
  if (cwd) {
    const { found, value } = resolveConfigKey("workflow.plan_review_on_exhaustion", loadConfig(cwd));
    const fromConfig = found ? parse(typeof value === "string" ? value.trim().toLowerCase() : value) : undefined;
    if (fromConfig) return fromConfig;
  }
  return DEFAULT_PLAN_REVIEW_EXHAUSTION_POLICY;
}

export function createPlanReviewBudget(cwd?: string): PlanReviewBudget {
  return { used: 0, max: resolvePlanReviewRounds(cwd) };
}

export function planReviewBudgetStatus(budget: PlanReviewBudget) {
  return {
    used: budget.used,
    max: budget.max,
    remaining: Math.max(0, budget.max - budget.used),
    exhausted: budget.used >= budget.max,
    exhaustionBlocks: ["new_council", "plan_rewrite"],
    exhaustionDoesNotBlock: [
      "read_only_verification",
      "complete_unchanged_bound_review",
      "one_independent_plan_revalidation",
    ],
    revalidationScope:
      "One independent verification per exact planning inputs and source fingerprint. Corrected inputs can be verified again under the original council without resetting its allowance; changed reason alone cannot retry unchanged failed work.",
    scope:
      "Current user request; plan rewrites and provider retries do not reset this allowance. A new user request starts a new allowance, not an approved plan.",
  };
}
