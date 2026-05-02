import type { ModelTier } from "../types/index.js";

/**
 * Classify a model into fast/balanced/premium tier based on its id and pricing.
 * Works across all providers — uses name heuristics + pricing signals.
 */

const FAST_PATTERNS = [
  /haiku/i, /mini/i, /flash/i, /nano/i, /small/i, /lite/i,
  /gpt-4o-mini/i, /gpt-3/i,
  /deepseek-chat/i,
  /grok-3-mini/i, /grok-2/i,
  /gemma/i, /phi-/i, /llama.*8b/i,
];

const PREMIUM_PATTERNS = [
  /opus/i, /pro(?!ject)/i,
  /\bo[13]-(?!mini)/i, /o1(?!-mini)/i, /o3(?!-mini)/i,
  /deepseek-reasoner/i,
  /grok-3(?!-mini)/i,
  /ultra/i, /large/i,
];

export function classifyModelTier(id: string, inputPrice?: number, outputPrice?: number): ModelTier {
  const lower = id.toLowerCase();

  if (FAST_PATTERNS.some((p) => p.test(lower))) return "fast";
  if (PREMIUM_PATTERNS.some((p) => p.test(lower))) return "premium";

  // Pricing-based fallback: cheap = fast, expensive = premium
  if (typeof inputPrice === "number" && inputPrice > 0) {
    if (inputPrice <= 1) return "fast";
    if (inputPrice >= 10) return "premium";
  }

  return "balanced";
}
