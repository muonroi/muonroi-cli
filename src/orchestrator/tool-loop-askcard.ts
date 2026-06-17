/**
 * src/orchestrator/tool-loop-askcard.ts
 *
 * Pure helper that computes the tool-loop-cap askcard tier (label set + default
 * action) from the current step number and the resolved natural ceiling for
 * the (taskType, size) matrix.
 *
 * Four tiers (open intervals — boundaries belong to the higher tier):
 *   - early       : step < 0.5 × ceiling — a transient fixation. Default Continue.
 *   - normal      : 0.5× ≤ step ≤ 2× ceiling — used cheap budget; Default Stop.
 *   - overBudget  : 2× < step ≤ 5× ceiling — Continue still available but the
 *                   label carries the overage multiplier so the cost of
 *                   continuing is visible at decision time. Default Stop.
 *   - extreme     : step > 5× ceiling — Stop is moved FIRST in the option
 *                   array (Enter = Stop) and Continue is labelled "expensive".
 *                   Default Stop (now at index 0).
 *
 * Live miss this tier set fixes (session 1f29e238, step 77/6 = 12.8×): extreme
 * tier put Stop first with a warning — good. But the storyflow_ui session
 * 22661c8de9f2 ran step 29/12 = 2.4× — the OLD code had no middle warning, so
 * the askcard showed a plain "Continue (let agent try)" with no signal that
 * continuing costs more. User chose Continue, the model stalled 4 tool-calls
 * later, and forced-finalize had to rescue a degraded answer.
 *
 * Pure — no React, no DOM, no side effects. Unit-testable in isolation.
 */

export type LoopCapTier = "early" | "normal" | "overBudget" | "extreme";

export interface LoopCapAskcardOptions {
  /** AI-SDK step number when the pattern fired. */
  stepNumber: number;
  /**
   * Natural step ceiling for (taskType, size). Optional — when undefined we
   * cannot compute multipliers, so the askcard falls back to the legacy
   * step-threshold heuristic (step ≤ 15 = early-ish, else normal).
   */
  naturalCeiling?: number;
}

export interface LoopCapAskcardLayout {
  tier: LoopCapTier;
  /** Index into `optionLabels` of the option pre-selected (Enter applies). */
  defaultIndex: 0 | 1;
  /**
   * Exactly two labels in render order. The first is at index 0, the second
   * at index 1 — order matters for the askcard UI (arrow-key navigation,
   * Enter-applies-default).
   */
  optionLabels: [continueOrStop: string, stopOrContinue: string];
  /** Values parallel to optionLabels — what the resolver returns to the loop. */
  optionValues: [string, string];
  /**
   * x.x string (e.g. "2.4") when the tier is overBudget or extreme, else
   * null. Caller can also surface this in the askcard context message.
   */
  overageMultiplier: string | null;
}

const NORMAL_LABELS: LoopCapAskcardLayout["optionLabels"] = ["Continue (let agent try)", "Stop and answer"];
const NORMAL_VALUES: LoopCapAskcardLayout["optionValues"] = ["continue", "stop"];

/**
 * Decide the askcard layout for a tool-loop-cap pattern hit. Pure.
 */
export function planLoopCapAskcard(opts: LoopCapAskcardOptions): LoopCapAskcardLayout {
  const { stepNumber, naturalCeiling } = opts;

  // No ceiling → cannot compute multipliers. Fall back to a static threshold:
  // step ≤ 15 looks "early" enough to default Continue, else default Stop.
  if (!naturalCeiling || naturalCeiling <= 0) {
    const tier: LoopCapTier = stepNumber > 0 && stepNumber <= 15 ? "early" : "normal";
    return {
      tier,
      defaultIndex: tier === "early" ? 0 : 1,
      optionLabels: NORMAL_LABELS,
      optionValues: NORMAL_VALUES,
      overageMultiplier: null,
    };
  }

  const ratio = stepNumber / naturalCeiling;
  const multiplier = ratio.toFixed(1);

  if (ratio > 5) {
    return {
      tier: "extreme",
      defaultIndex: 0,
      optionLabels: ["Stop and answer (recommended)", `Continue anyway (⚠ ${multiplier}× over budget — expensive)`],
      optionValues: ["stop", "continue"],
      overageMultiplier: multiplier,
    };
  }

  if (ratio > 2) {
    return {
      tier: "overBudget",
      defaultIndex: 1,
      optionLabels: [
        `Continue (⚠ ${multiplier}× past natural budget — quality may degrade)`,
        "Stop and answer (recommended)",
      ],
      optionValues: NORMAL_VALUES,
      overageMultiplier: multiplier,
    };
  }

  if (ratio < 0.5) {
    return {
      tier: "early",
      defaultIndex: 0,
      optionLabels: NORMAL_LABELS,
      optionValues: NORMAL_VALUES,
      overageMultiplier: null,
    };
  }

  return {
    tier: "normal",
    defaultIndex: 1,
    optionLabels: NORMAL_LABELS,
    optionValues: NORMAL_VALUES,
    overageMultiplier: null,
  };
}
