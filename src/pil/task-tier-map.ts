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
