import type { PipelineContext } from "./types.js";
import { truncateToBudget } from "./budget.js";

export async function layer5Context(ctx: PipelineContext): Promise<PipelineContext> {
  const digest = ctx.resumeDigest;

  if (!digest || !digest.trim()) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "context-enrichment", applied: false, delta: "no-resume-digest" },
      ],
    };
  }

  const hint = `[flow-context: Resume from previous session]\n${digest.trim()}`;
  const budgetShare = Math.floor(ctx.tokenBudget * 0.25);
  const trimmed = truncateToBudget(hint, budgetShare);

  const runIdPart = ctx.activeRunId ? ` runId=${ctx.activeRunId}` : "";

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "context-enrichment",
        applied: true,
        delta: `chars=${trimmed.length}${runIdPart}`,
      },
    ],
  };
}
