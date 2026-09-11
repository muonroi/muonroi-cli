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
 * This is MEASUREMENT for the user's information only. `/ideal` has no spend cap
 * (user decision), so nothing here is compared against a budget and nothing
 * recommends shrinking the run.
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
  /** Only when the user typed `--max-sprints N`: the estimate for N sprints. */
  estTotalUsd: number | null;
  maxSprints: number | null;
}

/**
 * Estimate what one sprint of the run costs on the active session model. Used by
 * runStart to show the user a figure before the loop begins.
 */
export function previewRunCost(args: {
  sessionModelId: string;
  maxSprints?: number;
  heuristic?: SprintHeuristic;
}): CostPreview {
  const h = args.heuristic ?? DEFAULT_HEURISTIC;
  const maxSprints = typeof args.maxSprints === "number" && args.maxSprints > 0 ? args.maxSprints : null;
  const unpriced = (provider: string): CostPreview => ({
    modelId: args.sessionModelId,
    provider,
    pricingKnown: false,
    cachedInputAvailable: false,
    estPerSprintUsd: 0,
    estTotalUsd: null,
    maxSprints,
  });

  let provider: string;
  try {
    provider = detectProviderForModel(args.sessionModelId);
  } catch (err) {
    console.error(
      `[cost-preview] provider unknown for ${args.sessionModelId}; showing no estimate: ${(err as Error)?.message}`,
    );
    return unpriced("unknown");
  }
  const pricing = lookupPricing(provider, args.sessionModelId);
  if (!pricing) return unpriced(provider);

  const inputPerSprint = h.callsPerSprint * h.inputTokensPerCall + h.debateInputPerSprint;
  const outputPerSprint = h.callsPerSprint * h.outputTokensPerCall + h.debateOutputPerSprint;

  const cachedInputAvailable = typeof pricing.cached_input_per_million_usd === "number";
  const hitRate = cachedInputAvailable ? h.cacheHitRate : 0;
  const inputHit = Math.round(inputPerSprint * hitRate);
  const inputMiss = inputPerSprint - inputHit;

  const estPerSprintUsd = projectCostUSDWithCache(provider, args.sessionModelId, inputMiss, inputHit, outputPerSprint);
  return {
    modelId: args.sessionModelId,
    provider,
    pricingKnown: true,
    cachedInputAvailable,
    estPerSprintUsd,
    estTotalUsd: maxSprints === null ? null : estPerSprintUsd * maxSprints,
    maxSprints,
  };
}

/** Format the preview as a single content chunk for the UI. */
export function formatCostPreview(p: CostPreview): string {
  if (!p.pricingKnown) {
    return `**Cost estimate:** pricing not known for \`${p.modelId}\` (provider \`${p.provider}\`). Spend is still measured per call.`;
  }
  const lines = [
    `**Cost estimate** (heuristic, for information — /ideal runs without a spend limit):`,
    `- Model: \`${p.modelId}\` (${p.provider})${p.cachedInputAvailable ? " · prompt-cache priced" : ""}`,
    `- Per-sprint estimate: $${p.estPerSprintUsd.toFixed(3)}`,
  ];
  if (p.estTotalUsd !== null && p.maxSprints !== null) {
    lines.push(`- Estimate for ${p.maxSprints} sprint${p.maxSprints === 1 ? "" : "s"}: $${p.estTotalUsd.toFixed(2)}`);
  }
  return lines.join("\n");
}
