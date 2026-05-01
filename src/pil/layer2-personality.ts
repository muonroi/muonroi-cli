import { truncateToBudget } from "./budget.js";
import type { OutputStyle, PipelineContext } from "./types.js";

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
