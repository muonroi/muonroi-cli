/**
 * Token counting backed by gpt-tokenizer (o200k_base / cl100k_base BPE) with a
 * chars/4 fallback.
 *
 * The tokenizer is a proxy: not every provider uses these encodings, but for
 * compaction-trigger decisions it is much closer to ground truth than chars/4
 * (which underestimates code by ~25–35% and overestimates prose by ~15–20%).
 *
 * If the import fails for any reason (bundler quirk, runtime issue), we
 * silently fall back so compaction never crashes on a token estimate.
 */

import { encode as encodeCl100k } from "gpt-tokenizer";

let useFallback = false;
let providerHint: string | null = null;

/**
 * Per-provider correction factors applied on top of cl100k_base BPE counts.
 * cl100k_base is 0% for OpenAI GPT-3.5/4 and a close proxy for tiktoken-family
 * tokenizers. For providers with mildly different vocabularies, a small
 * multiplier compensates for systematic under/over-count.
 *
 * Empirical baselines (English + code; CJK varies more):
 *   deepseek: ~+5%  (similar tiktoken family, slightly larger vocab)
 *
 * Keep this map small and conservative — multipliers > 1.15 indicate the
 * provider really needs its own tokenizer, not a fudge factor.
 */
const PROVIDER_MULTIPLIER: Record<string, number> = {
  deepseek: 1.05,
};

function multiplierFor(provider: string | null): number {
  if (!provider) return 1;
  return PROVIDER_MULTIPLIER[provider] ?? 1;
}

/**
 * Tell the tokenizer which provider is in use. Set once at orchestrator init
 * (or whenever the active provider changes). Defaults to no correction if
 * the provider is unknown.
 */
export function setProviderHint(provider: string | null | undefined): void {
  providerHint = provider ?? null;
}

export function getProviderHint(): string | null {
  return providerHint;
}

function fallbackCharCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Best-effort token count for a single string.
 * Returns 0 for empty input. Falls back to chars/4 if the tokenizer throws.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (useFallback) return fallbackCharCount(text);
  try {
    const base = encodeCl100k(text).length;
    const mult = multiplierFor(providerHint);
    return mult === 1 ? base : Math.ceil(base * mult);
  } catch {
    useFallback = true;
    return fallbackCharCount(text);
  }
}

/** For tests / diagnostics. */
export function isTokenizerReady(): boolean {
  return !useFallback;
}

/** For tests — force the fallback path. */
export function __forceFallbackForTests(value: boolean): void {
  useFallback = value;
}
