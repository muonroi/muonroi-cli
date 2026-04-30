import type { PipelineContext, OutputStyle } from "./types.js";
import { truncateToBudget } from "./budget.js";

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
  if (!ctx.outputStyle) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "personality-adaptation", applied: false, delta: "skipped:null-outputStyle" },
      ],
    };
  }

  const hint = PERSONALITY_HINTS[ctx.outputStyle];
  const trimmed = truncateToBudget(hint, Math.floor(ctx.tokenBudget * 0.2));

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "personality-adaptation",
        applied: true,
        delta: `style=${ctx.outputStyle} chars=${trimmed.length}`,
      },
    ],
  };
}
