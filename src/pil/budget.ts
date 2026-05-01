/**
 * src/pil/budget.ts
 *
 * Token budget utilities for Layer 3-5 context enrichment.
 * Prevents context bloat by enforcing character limits on injected content.
 */

export const DEFAULT_TOKEN_BUDGET = 500;

const CHARS_PER_TOKEN = 4;

export function truncateToBudget(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated}...`;
}
