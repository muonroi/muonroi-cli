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
