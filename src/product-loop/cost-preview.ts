import { lookupPricing } from "../providers/pricing.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { projectCostUSDWithCache } from "../usage/estimator.js";

/**
 * Heuristic per-sprint token volume. These numbers come from observed traffic
 * on /ideal sprints: each sprint runs ~6 LLM calls (clarifier turn, debate
 * round, scoping synth, sprint plan, verify, reflect) with ~8K input tokens
 * (system + spec + history) and ~2K output. The debate phase compounds with
 * N=4 stances — counted once per outer sprint as ~30K input / 6K output total.
 * Assume ~70% prompt cache hit rate after the first sprint (typical when the
 * spec text dominates context).
 *
 * Bias: rounded UP so the user sees a conservative estimate; better to scare
 * with $42 than surprise with $35.
 */
export interface SprintHeuristic {
  callsPerSprint: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  debateInputPerSprint: number;
  debateOutputPerSprint: number;
  /** Fraction of input that hits the prompt cache after sprint 1 (0..1). */
  cacheHitRate: number;
}

export const DEFAULT_HEURISTIC: SprintHeuristic = {
  callsPerSprint: 6,
  inputTokensPerCall: 8_000,
  outputTokensPerCall: 2_000,
  debateInputPerSprint: 30_000,
  debateOutputPerSprint: 6_000,
  cacheHitRate: 0.7,
};

export interface CostPreview {
  modelId: string;
  provider: string;
  pricingKnown: boolean;
  cachedInputAvailable: boolean;
  estPerSprintUsd: number;
  estTotalUsd: number;
  capUsd: number;
  willExceedCap: boolean;
  /** Recommended max-sprints if you want to stay strictly under cap. */
  recommendedMaxSprints: number;
}

/**
 * Predict the run's USD cost given the active session model + flags. Used by
 * runStart to surface a cost-vs-cap warning before the loop begins.
 */
export function previewRunCost(args: {
  sessionModelId: string;
  maxSprints: number;
  capUsd: number;
  heuristic?: SprintHeuristic;
}): CostPreview {
  const h = args.heuristic ?? DEFAULT_HEURISTIC;
  const provider = detectProviderForModel(args.sessionModelId);
  const pricing = lookupPricing(provider, args.sessionModelId);

  if (!pricing) {
    return {
      modelId: args.sessionModelId,
      provider,
      pricingKnown: false,
      cachedInputAvailable: false,
      estPerSprintUsd: 0,
      estTotalUsd: 0,
      capUsd: args.capUsd,
      willExceedCap: false,
      recommendedMaxSprints: args.maxSprints,
    };
  }

  const inputPerSprint = h.callsPerSprint * h.inputTokensPerCall + h.debateInputPerSprint;
  const outputPerSprint = h.callsPerSprint * h.outputTokensPerCall + h.debateOutputPerSprint;

  const cachedInputAvailable = typeof pricing.cached_input_per_million_usd === "number";
  const hitRate = cachedInputAvailable ? h.cacheHitRate : 0;
  const inputHit = Math.round(inputPerSprint * hitRate);
  const inputMiss = inputPerSprint - inputHit;

  const estPerSprintUsd = projectCostUSDWithCache(provider, args.sessionModelId, inputMiss, inputHit, outputPerSprint);
  const estTotalUsd = estPerSprintUsd * args.maxSprints;
  const willExceedCap = estTotalUsd > args.capUsd;
  const recommendedMaxSprints =
    estPerSprintUsd > 0 ? Math.max(1, Math.floor(args.capUsd / estPerSprintUsd)) : args.maxSprints;

  return {
    modelId: args.sessionModelId,
    provider,
    pricingKnown: true,
    cachedInputAvailable,
    estPerSprintUsd,
    estTotalUsd,
    capUsd: args.capUsd,
    willExceedCap,
    recommendedMaxSprints,
  };
}

/** Format the preview as a single content chunk for the UI. */
export function formatCostPreview(p: CostPreview): string {
  if (!p.pricingKnown) {
    return `**Cost preview:** pricing not known for \`${p.modelId}\` (provider \`${p.provider}\`); cap = $${p.capUsd}. Spend will be tracked but cannot be projected.`;
  }
  const lines = [
    `**Cost preview** (heuristic):`,
    `- Model: \`${p.modelId}\` (${p.provider})${p.cachedInputAvailable ? " · prompt-cache priced" : ""}`,
    `- Per-sprint estimate: $${p.estPerSprintUsd.toFixed(3)}`,
    `- Total estimate (×max-sprints): $${p.estTotalUsd.toFixed(2)}`,
    `- Cap: $${p.capUsd.toFixed(2)}`,
  ];
  if (p.willExceedCap) {
    lines.push(
      `- ⚠️ Estimate **exceeds** cap. Recommended \`--max-sprints ${p.recommendedMaxSprints}\` to fit budget, or raise \`--max-cost\`.`,
    );
  } else {
    lines.push(`- ✓ Estimate fits the cap.`);
  }
  return lines.join("\n");
}
