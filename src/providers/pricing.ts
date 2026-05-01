/**
 * src/providers/pricing.ts
 *
 * Static pricing map: {provider, model} -> {input_per_million_usd, output_per_million_usd}.
 * Phase 1 ships static; Phase 4 (WEB-02) adds remote fetch.
 * PROV-06 requirement.
 *
 * Prices verified 2026-04-29 from official provider pricing pages.
 * Freshness policy: re-verify every 60 days.
 */

export interface PricePerMillion {
  input_per_million_usd: number;
  output_per_million_usd: number;
}

// verified 2026-04-29 from official provider pricing pages
export const PRICING: Record<string, Record<string, PricePerMillion>> = {
  anthropic: {
    "claude-3-5-haiku-latest": { input_per_million_usd: 0.8, output_per_million_usd: 4.0 }, // anthropic.com/pricing
    "claude-3-5-sonnet-latest": { input_per_million_usd: 3.0, output_per_million_usd: 15.0 }, // anthropic.com/pricing
    "claude-3-opus-latest": { input_per_million_usd: 15.0, output_per_million_usd: 75.0 }, // anthropic.com/pricing
  },
  openai: {
    "gpt-4o": { input_per_million_usd: 2.5, output_per_million_usd: 10.0 }, // openai.com/api/pricing
    "gpt-4o-mini": { input_per_million_usd: 0.15, output_per_million_usd: 0.6 }, // openai.com/api/pricing
    o1: { input_per_million_usd: 15.0, output_per_million_usd: 60.0 }, // openai.com/api/pricing
  },
  google: {
    "gemini-2.5-flash": { input_per_million_usd: 0.3, output_per_million_usd: 2.5 }, // ai.google.dev/pricing
    "gemini-pro-latest": { input_per_million_usd: 1.25, output_per_million_usd: 10.0 }, // ai.google.dev/pricing
  },
  deepseek: {
    "deepseek-chat": { input_per_million_usd: 0.27, output_per_million_usd: 1.1 }, // api-docs.deepseek.com
    "deepseek-reasoner": { input_per_million_usd: 0.55, output_per_million_usd: 2.19 }, // api-docs.deepseek.com
  },
  siliconflow: {
    "Qwen/Qwen2.5-Coder-32B-Instruct": { input_per_million_usd: 0.18, output_per_million_usd: 0.18 }, // siliconflow.cn/pricing
  },
  ollama: {
    // local-only — zero variable cost
    "*": { input_per_million_usd: 0, output_per_million_usd: 0 },
  },
};

/**
 * Look up pricing for a (provider, model) pair.
 * Returns undefined if provider or model is not in the static table.
 * Ollama uses a '*' wildcard that matches any model.
 */
export function lookupPricing(provider: string, model: string): PricePerMillion | undefined {
  const byProvider = PRICING[provider];
  if (!byProvider) return undefined;
  return byProvider[model] ?? byProvider["*"];
}
