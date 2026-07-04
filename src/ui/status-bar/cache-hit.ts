/** Cache-hit ratio = cache_read / total input (cumulative). `in_tokens` already
 *  includes cache-read tokens (verified: usage_events cache_read ⊆ input_tokens). */
export function computeCacheHitPct(s: { in_tokens: number; cache_read_tokens: number }): number | null {
  if (s.in_tokens <= 0) return null;
  const pct = (s.cache_read_tokens / s.in_tokens) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
