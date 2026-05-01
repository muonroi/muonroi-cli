import { detectGsdPhase, type GsdPhase } from "../gsd/types.js";
import { routeTask } from "../ee/bridge.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

const PHASE_HINTS: Record<GsdPhase, string> = {
  discuss:
    "[gsd: discuss phase — Explore options and trade-offs. Ask clarifying questions. " +
    "Don't commit to implementation yet. Surface assumptions and risks.]",
  plan:
    "[gsd: plan phase — Create a structured plan with clear steps. Define success criteria. " +
    "Identify dependencies and risks. Break work into small, testable tasks.]",
  execute:
    "[gsd: execute phase — Implement one task at a time. Write tests first (TDD). " +
    "Make atomic commits. Follow the plan — flag deviations, don't freelance.]",
  verify:
    "[gsd: verify phase — Run tests and verify behavior matches requirements. " +
    "Check edge cases. Validate against success criteria. Report gaps.]",
  review:
    "[gsd: review phase — Evaluate code quality, correctness, and completeness. " +
    "Check for security issues, performance concerns, and maintainability.]",
};

function mapRouteToPhase(route: string): GsdPhase | null {
  switch (route) {
    case "qc-flow":
      return "discuss";
    case "qc-lock":
      return "execute";
    case "direct":
      return null;
    default:
      return null;
  }
}

export async function layer4Gsd(ctx: PipelineContext): Promise<PipelineContext> {
  let phase: GsdPhase | null = (ctx.gsdPhase as GsdPhase) ?? null;
  let routeSource = "keyword";

  if (!phase) {
    const eeRoute = await routeTask(ctx.raw).catch(() => null);
    if (eeRoute?.route && !eeRoute.needs_disambiguation && eeRoute.confidence >= 0.6) {
      phase = mapRouteToPhase(eeRoute.route);
      routeSource = `ee:${eeRoute.source}`;
    }
  }

  if (!phase) {
    phase = detectGsdPhase(ctx.raw);
    routeSource = "keyword";
  }

  if (!phase) {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "gsd-workflow-structuring", applied: false, delta: "no-phase-detected" }],
    };
  }

  const hint = PHASE_HINTS[phase];
  const trimmed = truncateToBudget(hint, Math.floor(ctx.tokenBudget * 0.15));

  return {
    ...ctx,
    gsdPhase: phase,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "gsd-workflow-structuring",
        applied: true,
        delta: `phase=${phase} source=${routeSource} chars=${trimmed.length}`,
      },
    ],
  };
}
