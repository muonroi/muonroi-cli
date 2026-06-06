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
import { getModelByTier } from "../models/registry.js";

export type ModelTaskKind = "compact" | "explore" | "general" | "title" | "verify";

export const TASK_TIER_PREFS: Record<ModelTaskKind, Array<"fast" | "balanced" | "premium">> = {
  compact: ["fast", "balanced"],
  title: ["fast", "balanced"],
  explore: ["balanced", "fast"],
  // general sub-agents downgrade to balanced (was premium-first) — the top
  // model already planned the delegation; the focused execution doesn't need
  // premium. Premium remains the fallback so premium-only providers are unaffected.
  general: ["balanced", "premium"],
  // verify keeps premium-first: a downgrade here would weaken the very check it
  // exists to perform. Mirrors council `verify` role preference.
  verify: ["premium", "balanced"],
};

/** getModelByTier signature, injectable for testing. */
export type TierLookup = (
  tier: "fast" | "balanced" | "premium",
  preferProvider?: string,
) => { id: string; provider: string } | undefined;

/**
 * Resolve the model id for a task kind on a given provider. Walks the tier
 * preference list, accepting only same-provider matches, and falls back to
 * `fallbackModelId` (the parent model) when nothing matches.
 */
export function resolveModelForTask(
  task: ModelTaskKind,
  providerId: string,
  fallbackModelId: string,
  lookup: TierLookup = getModelByTier as TierLookup,
): string {
  for (const tier of TASK_TIER_PREFS[task] ?? ["balanced"]) {
    const m = lookup(tier, providerId);
    if (m?.provider === providerId) return m.id;
  }
  return fallbackModelId;
}
