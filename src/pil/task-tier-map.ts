/**
 * src/pil/task-tier-map.ts
 *
 * Maps PIL TaskTypes to EE routing tiers.
 * EE tiers: 'fast' | 'balanced' | 'premium'
 *
 * Rationale for each mapping:
 * - fast: Low-complexity tasks where speed matters more than model depth
 * - balanced: Most coding tasks — needs competence but not premium reasoning
 * - premium: High-stakes planning tasks requiring deep reasoning
 */

import type { ModelRole } from "../utils/settings.js";

export type EETier = "fast" | "balanced" | "premium";

/**
 * Single canonical list of the three real EE routing tiers, in rank order
 * (fast < balanced < premium). Shared by `router/decide.ts` (tier arithmetic)
 * and `ee/bridge.ts` (validating a tier value that arrived over the network)
 * so both sides can never drift apart on what counts as a "real" tier.
 */
export const EE_TIERS: readonly EETier[] = ["fast", "balanced", "premium"];

/**
 * True only for an exact, case-sensitive match against one of the three real
 * tier literals. Anything else — an unrecognized string, a case mismatch, or a
 * non-string value — is NOT a known tier and must be treated as absent (no
 * signal), never as "lower than every real tier".
 *
 * Case-sensitive by design, matching the sibling whitelist convention in
 * `getRoutingPromoteMax`/`getRoutingDemoteMin` (src/utils/settings.ts): these
 * are machine-to-machine API contract values (an EE JSON response field), not
 * user-typed free text, so silently normalizing a case mismatch would hide a
 * real EE-side schema drift instead of surfacing it as "no advice".
 */
export function isEETier(value: unknown): value is EETier {
  return typeof value === "string" && (EE_TIERS as readonly string[]).includes(value);
}

const MAP: Record<string, EETier> = {
  refactor: "balanced",
  debug: "balanced",
  plan: "premium",
  analyze: "balanced",
  documentation: "fast",
  generate: "balanced",
  build: "balanced", // greenfield creation — competent coding tier, same as generate
  general: "fast",
};

/**
 * Map a PIL taskType to an EE routing tier.
 * Returns 'fast' for null (conversational turns).
 * Returns 'balanced' for unknown task types (safe fallback).
 */
export function taskTypeToTier(taskType: string | null): EETier {
  if (!taskType) return "fast";
  return MAP[taskType] ?? "balanced";
}

/**
 * Map a PIL taskType to an appropriate maxOutputTokens budget.
 *
 * PIL-L6 verbosity fix — budgets cut roughly in half from the prior values
 * (debug 6K→3K, refactor 6K→4K, plan 8K→5K, generate 12K→8K, analyze 4K→2K,
 * docs 4K→3K, default 4K→2K). Old values let "balanced" / "detailed" styles
 * pad answers with end-of-turn summaries that users skip. Truncation at the
 * tighter limit is preferable to bloat — agent will retry if it needs more.
 */
export function taskTypeToMaxTokens(taskType: string | null): number {
  switch (taskType) {
    case "analyze":
      return 4_096;
    case "documentation":
      return 4_096;
    case "debug":
      return 6_144;
    case "refactor":
      return 6_144;
    case "plan":
      return 8_192;
    case "generate":
    case "build":
      return 12_288;
    default:
      return 4_096; // conversational
  }
}

/**
 * Map a PIL taskType to a reasoning effort level.
 * High-stakes planning gets full reasoning; simple tasks get minimal.
 */
export function taskTypeToReasoningEffort(taskType: string | null): "low" | "medium" | "high" {
  switch (taskType) {
    case "plan":
      return "high";
    case "debug":
    case "refactor":
    case "generate":
    case "build":
      return "medium";
    case "analyze":
    case "documentation":
      return "low";
    default:
      return "low"; // conversational — minimal reasoning
  }
}

const ROLE_MAP: Record<string, ModelRole> = {
  plan: "leader",
  analyze: "leader",
  generate: "implement",
  build: "implement",
  refactor: "implement",
  debug: "verify",
  documentation: "research",
};

export function taskTypeToRole(taskType: string | null): ModelRole | null {
  if (!taskType) return null;
  return ROLE_MAP[taskType] ?? null;
}
