/** Host-owned resource allowance for one user request, shared across SDK retries. */
export interface PlanReviewBudget {
  used: number;
  max: number;
  stopRequested?: boolean;
}

export function createPlanReviewBudget(): PlanReviewBudget {
  const configured = Number(process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS);
  return { used: 0, max: Number.isSafeInteger(configured) && configured >= 1 ? Math.min(configured, 20) : 3 };
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
