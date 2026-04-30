import type { PipelineContext } from "./types.js";
import { truncateToBudget } from "./budget.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

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

  const isStale = typeof ctx.digestAgeMs === "number" && ctx.digestAgeMs > STALE_THRESHOLD_MS;
  const stalePrefix = isStale
    ? "(stale — this digest may be outdated, verify before relying on it)\n"
    : "";
  const hint = `[flow-context: Resume from previous session]\n${stalePrefix}${digest.trim()}`;
  const budgetShare = Math.floor(ctx.tokenBudget * 0.25);
  const trimmed = truncateToBudget(hint, budgetShare);

  const runIdPart = ctx.activeRunId ? ` runId=${ctx.activeRunId}` : "";
  const stalePart = isStale ? " stale=true" : "";

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "context-enrichment",
        applied: true,
        delta: `chars=${trimmed.length}${runIdPart}${stalePart}`,
      },
    ],
  };
}
