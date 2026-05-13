import { truncateToBudget } from "./budget.js";
import type { OutputStyle, PipelineContext } from "./types.js";

// TODO(WhoAmI-L2): when EE v4.0 Who Am I profile is available, replace
// static PERSONALITY_HINTS with a dynamically-built hint from the user profile:
//   communication.brevity       → concise/detailed bias
//   decision_speed              → skip exhaustive options, recommend once
//   feedback_style              → implicit = don't re-explain on "ok"
//   work_patterns.delegation    → autonomous = lead with action, not question
// ctx.outputStyle from L1 becomes an override signal, not the primary source.
// Until WhoAmI ships, L2 relies entirely on L1's per-turn detection.

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
