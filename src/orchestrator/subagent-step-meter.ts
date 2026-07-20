/**
 * Per-step cache instrumentation for the sub-agent (`task`) tool loop.
 *
 * The aggregate `task` usage event (recorded in stream-runner's onFinish)
 * reports a SINGLE cache-hit % for the whole sub-agent run. An 8% aggregate is
 * therefore un-attributable: is the growing prefix inherently uncacheable, or
 * does one late step dominate the fresh-billed total? This helper normalizes
 * each step's usage across the provider shapes the AI SDK surfaces so the cache
 * curve across the loop becomes falsifiable — the measure-first step BEFORE any
 * mid-loop-compaction or cache-key change.
 *
 * Extracted from the onStepFinish callback so the multi-provider usage parsing
 * (the only non-trivial part) is unit-testable without the heavy StreamRunner
 * dependency graph.
 */

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface StepCacheUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Normalize a single AI-SDK step's usage object into input / cache token
 * counts, tolerating the three shapes providers surface:
 *   - AI SDK v6 normalized:  { cachedInputTokens, inputTokens, outputTokens }
 *   - inputTokenDetails:     { cacheReadTokens, cacheWriteTokens }
 *   - provider raw passthru: { raw: { prompt_cache_hit_tokens, cache_creation_input_tokens } }
 * Missing fields default to 0 so a provider that reports no cache data yields a
 * clean 0% row rather than a gap.
 */
export function parseStepCacheUsage(usage: unknown): StepCacheUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = u.inputTokenDetails as Record<string, unknown> | undefined;
  const raw = u.raw as Record<string, unknown> | undefined;
  const inputTokens = asNumber(u.inputTokens) ?? asNumber(u.promptTokens) ?? 0;
  const outputTokens = asNumber(u.outputTokens) ?? asNumber(u.completionTokens) ?? 0;
  const cacheReadTokens =
    asNumber(u.cachedInputTokens) ?? asNumber(details?.cacheReadTokens) ?? asNumber(raw?.prompt_cache_hit_tokens) ?? 0;
  const cacheCreationTokens = asNumber(details?.cacheWriteTokens) ?? asNumber(raw?.cache_creation_input_tokens) ?? 0;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/** Cache-hit percentage (0–100, one decimal) for a step; 0 when no input. */
export function stepHitPct(u: StepCacheUsage): number {
  return u.inputTokens > 0 ? Math.round((1000 * u.cacheReadTokens) / u.inputTokens) / 10 : 0;
}

/** Whether per-step metering is enabled. Opt out with MUONROI_SUBAGENT_STEP_METER=0. */
export function isSubAgentStepMeterEnabled(): boolean {
  return process.env.MUONROI_SUBAGENT_STEP_METER !== "0";
}

/** Build the `data` payload for a `subagent_step` interaction-log row. */
export function buildSubAgentStepData(
  usage: unknown,
  ctx: { stepIndex: number; callId: string },
): StepCacheUsage & { stepIndex: number; callId: string; hitPct: number } {
  const parsed = parseStepCacheUsage(usage);
  return {
    ...parsed,
    stepIndex: ctx.stepIndex,
    callId: ctx.callId,
    hitPct: stepHitPct(parsed),
  };
}
