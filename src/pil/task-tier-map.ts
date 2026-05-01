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

export type EETier = "fast" | "balanced" | "premium";

const MAP: Record<string, EETier> = {
  refactor: "balanced",
  debug: "balanced",
  plan: "premium",
  analyze: "balanced",
  documentation: "fast",
  generate: "balanced",
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
 * Keeps conversational turns short and reserves headroom for generation-heavy tasks.
 */
export function taskTypeToMaxTokens(taskType: string | null): number {
  switch (taskType) {
    case "analyze":
    case "documentation":
      return 4_096;
    case "debug":
    case "refactor":
      return 6_144;
    case "plan":
      return 8_192;
    case "generate":
      return 12_288;
    default:
      return 4_096; // conversational — keep short
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
      return "medium";
    case "analyze":
    case "documentation":
      return "low";
    default:
      return "low"; // conversational — minimal reasoning
  }
}
