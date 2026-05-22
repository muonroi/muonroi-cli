/**
 * src/providers/pricing.ts
 *
 * Pricing lookup: catalog-first, then static fallback for providers not in catalog
 * (anthropic, openai, google — they're not in catalog.json).
 * Phase 1 ships static; Phase 4 (WEB-02) adds remote fetch.
 * PROV-06 requirement.
 *
 * Prices verified 2026-04-29 from official provider pricing pages.
 * Freshness policy: re-verify every 60 days.
 */

import { MODELS } from "../models/registry.js";

export interface PricePerMillion {
  input_per_million_usd: number;
  output_per_million_usd: number;
  /**
   * Optional cache-hit input price (per million tokens). When the provider
   * surfaces a cached-input rate (DeepSeek's prompt-cache hit, OpenAI cached
   * input, Anthropic cache-read), set this. Cost engines should bill the
   * cached portion at this rate and the miss portion at input_per_million_usd.
   * If omitted, treat input as fully un-cached.
   */
  cached_input_per_million_usd?: number;
  /**
   * Optional Anthropic-style cache-write surcharge per million. Anthropic
   * charges 1.25× input for cache writes; cost engines that track writes
   * separately can use this. Most providers won't set it.
   */
  cache_write_per_million_usd?: number;
}

// Static fallback for providers not in catalog (anthropic, openai, google).
// verified 2026-04-29 from official provider pricing pages; cache prices
// re-verified 2026-05-08 against deepseek-platform / openai / anthropic docs
export const STATIC_PRICING_FALLBACK: Record<string, Record<string, PricePerMillion>> = {
  anthropic: {
    "claude-3-5-haiku-latest": {
      input_per_million_usd: 0.8,
      output_per_million_usd: 4.0,
      cached_input_per_million_usd: 0.08, // 0.1× input (cache-read)
      cache_write_per_million_usd: 1.0, // 1.25× input
    },
    "claude-3-5-sonnet-latest": {
      input_per_million_usd: 3.0,
      output_per_million_usd: 15.0,
      cached_input_per_million_usd: 0.3,
      cache_write_per_million_usd: 3.75,
    },
    "claude-3-opus-latest": {
      input_per_million_usd: 15.0,
      output_per_million_usd: 75.0,
      cached_input_per_million_usd: 1.5,
      cache_write_per_million_usd: 18.75,
    },
  },
  openai: {
    "gpt-4o": {
      input_per_million_usd: 2.5,
      output_per_million_usd: 10.0,
      cached_input_per_million_usd: 1.25, // 0.5× input
    },
    "gpt-4o-mini": {
      input_per_million_usd: 0.15,
      output_per_million_usd: 0.6,
      cached_input_per_million_usd: 0.075,
    },
    o1: {
      input_per_million_usd: 15.0,
      output_per_million_usd: 60.0,
      cached_input_per_million_usd: 7.5,
    },
  },
  google: {
    "gemini-2.5-flash": { input_per_million_usd: 0.3, output_per_million_usd: 2.5 }, // ai.google.dev/pricing
    "gemini-pro-latest": { input_per_million_usd: 1.25, output_per_million_usd: 10.0 }, // ai.google.dev/pricing
  },
  deepseek: {
    // DeepSeek V4 chat: $0.27/M input miss, $0.027/M input hit, $1.10/M output
    // (api-docs.deepseek.com/quick_start/pricing). Flash/Pro split below mirrors
    // their public chat / reasoner tiers; refresh quarterly.
    "deepseek-v4-flash": {
      input_per_million_usd: 0.27,
      cached_input_per_million_usd: 0.027,
      output_per_million_usd: 1.1,
    },
    "deepseek-v4-pro": {
      input_per_million_usd: 0.55,
      cached_input_per_million_usd: 0.055,
      output_per_million_usd: 2.19,
    },
  },
  siliconflow: {
    "Qwen/Qwen2.5-Coder-32B-Instruct": { input_per_million_usd: 0.18, output_per_million_usd: 0.18 }, // siliconflow.com/pricing
    // DeepSeek models served via SiliconFlow — keep in sync with catalog.json.
    "deepseek-ai/DeepSeek-V4-Flash": { input_per_million_usd: 0.1, output_per_million_usd: 0.4 },
    "deepseek-ai/DeepSeek-V4-Pro": { input_per_million_usd: 2.0, output_per_million_usd: 8.0 },
  },
  ollama: {
    // local-only — zero variable cost
    "*": { input_per_million_usd: 0, output_per_million_usd: 0 },
  },
};

/**
 * Look up pricing for a (provider, model) pair.
 * Checks catalog first (preferred — single source of truth).
 * Falls back to static table for models not in catalog (anthropic, openai, google, legacy providers).
 * Returns undefined if provider or model is not found in either source.
 * Ollama uses a '*' wildcard in the static table that matches any model.
 */
export function lookupPricing(provider: string, model: string): PricePerMillion | undefined {
  // 1. Try catalog first
  const catalogModel = MODELS.find((m) => m.id === model && m.provider === provider);
  if (catalogModel && catalogModel.inputPrice != null) {
    return {
      input_per_million_usd: catalogModel.inputPrice,
      output_per_million_usd: catalogModel.outputPrice,
      ...(catalogModel.cachedInputPrice != null ? { cached_input_per_million_usd: catalogModel.cachedInputPrice } : {}),
      ...(catalogModel.cacheWritePrice != null ? { cache_write_per_million_usd: catalogModel.cacheWritePrice } : {}),
    };
  }
  // 2. Fallback to static table for models not in catalog (legacy providers)
  const byProvider = STATIC_PRICING_FALLBACK[provider];
  if (!byProvider) return undefined;
  return byProvider[model] ?? byProvider["*"];
}
