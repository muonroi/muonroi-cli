import { truncateToBudget } from "./budget.js";
import type { OutputStyle, PipelineContext } from "./types.js";

// WhoAmI v4.0 (partly wired): ctx.outputStyle now carries the profile baseline
// from communication.brevity / decision_speed (resolved in layer1-intent.ts via
// ../ee/who-am-i.ts), so the concise/detailed bias below is already profile-aware
// without changing this layer — L1's per-turn detection overrides it. Still future:
// a richer hint built directly from feedback_style (EE emits implicit |
// precise-correction). NOTE: `work_patterns.delegation_style` is NOT emitted by EE
// slice-1 — do not wire it until a later EE slice adds it.

const DEFAULT_PERSONALITY: OutputStyle = "balanced";

const PERSONALITY_HINTS: Record<OutputStyle, string> = {
  concise:
    "[personality: concise — Be direct and terse. Lead with the answer. Skip preamble. " +
    "Use bullet points over paragraphs. Code over prose. No filler phrases.]",
  detailed:
    "[personality: detailed — Be thorough and explanatory. Show your reasoning step-by-step. " +
    "Include context, examples, and edge cases. Explain trade-offs.]",
  balanced:
    "[personality: balanced — Balance brevity with clarity. Lead with the key point, " +
    "then add essential context. Use examples only when they clarify.]",
};

export async function layer2Personality(ctx: PipelineContext): Promise<PipelineContext> {
  const style: OutputStyle = ctx.outputStyle ?? DEFAULT_PERSONALITY;

  const hint = PERSONALITY_HINTS[style];
  const trimmed = truncateToBudget(hint, Math.floor(ctx.tokenBudget * 0.2));

  return {
    ...ctx,
    outputStyle: style,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "personality-adaptation",
        applied: true,
        delta: `style=${style} source=${ctx.outputStyle ? "detected" : "default"} chars=${trimmed.length}`,
      },
    ],
  };
}
