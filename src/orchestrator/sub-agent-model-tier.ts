/**
 * Tier policy for picking the model of a mechanical/delegated task within a turn.
 *
 * The parent (top) model decides WHAT to do; the focused sub-task that follows
 * rarely needs the top premium model. Each task kind declares a tier preference,
 * resolved against the CURRENT provider only — we never cross providers here to
 * avoid billing surprises (a stray key) and keychain complexity. If no model at
 * a preferred tier exists on the provider, we fall through to the next tier and
 * finally to the parent model, so a premium-only provider sees no change.
 *
 * Kinds:
 *  - compact / title : pure mechanical text ops → cheapest first.
 *  - explore         : read-only research → balanced is plenty.
 *  - general         : delegated multi-step execution → balanced (the parent
 *                      already did the hard thinking); falls back to premium.
 *  - verify          : validation/verification → premium first; rigor matters
 *                      more than cost here, so we do NOT downgrade by default.
 */
import { getRoutedModelByTier } from "../router/peak-hour.js";

export type ModelTaskKind = "compact" | "explore" | "general" | "title" | "verify";

export const TASK_TIER_PREFS: Record<ModelTaskKind, Array<"fast" | "balanced" | "premium">> = {
  compact: ["fast", "balanced"],
  title: ["fast", "balanced"],
  explore: ["balanced", "fast"],
  // general sub-agents downgrade to balanced (was premium-first) — the top
  // model already planned the delegation; the focused execution doesn't need
  // premium. Premium remains the fallback so premium-only providers are unaffected.
  general: ["balanced", "fast", "premium"],
  // verify keeps premium-first: a downgrade here would weaken the very check it
  // exists to perform. Mirrors council `verify` role preference.
  verify: ["premium", "balanced"],
};

/** getModelByTier signature, injectable for testing. */
export type TierLookup = (
  tier: "fast" | "balanced" | "premium",
  preferProvider?: string,
) => { id: string; provider: string } | undefined;

const TIER_RANK: Record<"fast" | "balanced" | "premium", number> = { fast: 0, balanced: 1, premium: 2 };

/**
 * Resolve the model id for a task kind on a given provider. Walks the tier
 * preference list, accepting only same-provider matches, and falls back to
 * `fallbackModelId` (the parent model) when nothing matches.
 *
 * `opts.parentTier` (the top-level / parent model's tier) acts as a ceiling:
 * a delegated sub-task never runs on a HIGHER tier than the parent. Without
 * this cap, a `verify` sub-agent (prefs `["premium","balanced"]`) spawned from
 * a flash (fast) parent silently promotes to premium — e.g. on a DeepSeek-only
 * setup (no balanced model) every verify sub-agent lands on deepseek-v4-pro.
 * The parent already did the hard thinking; the sub-task should not exceed it.
 *
 * The cap is skipped when `parentTier` is omitted (preserves legacy behavior
 * for callers that have not been threaded yet).
 */
export function resolveModelForTask(
  task: ModelTaskKind,
  providerId: string,
  fallbackModelId: string,
  lookup: TierLookup = getRoutedModelByTier as TierLookup,
  opts?: { parentTier?: "fast" | "balanced" | "premium" },
): string {
  const ceilingRank = opts?.parentTier ? TIER_RANK[opts.parentTier] : undefined;
  for (const tier of TASK_TIER_PREFS[task] ?? ["balanced"]) {
    if (ceilingRank !== undefined && TIER_RANK[tier] > ceilingRank) continue;
    const m = lookup(tier, providerId);
    if (m?.provider === providerId) return m.id;
  }
  return fallbackModelId;
}
