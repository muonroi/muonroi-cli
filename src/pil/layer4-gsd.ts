/**
 * src/pil/layer4-gsd.ts
 *
 * Layer 4: GSD-native workflow structuring.
 *
 * Three-tier triage:
 *   - heavy:    inject mandatory discuss → research → verify → plan → impl → verify directive
 *   - standard: GSD-quick mindset (short plan + impl + verify)
 *   - quick:    minimal hint, run inline
 *
 * Phase detection still flows through the EE bridge first, then keyword
 * fallback. The chosen phase becomes a hint inside the heavy/standard
 * directive but never overrides the complexity-driven flow.
 *
 * All injected text is English. Per project rules, only user-facing text
 * (questions surfaced via AskUserQuestion) is localised — at render time, by
 * the agent, into the user's language.
 */

import { routeTask } from "../ee/bridge.js";
import { scoreComplexity } from "../gsd/complexity.js";
import { buildDirective } from "../gsd/directives.js";
import { detectGrayAreas } from "../gsd/gray-areas.js";
import { detectGsdPhase, type GsdPhase } from "../gsd/types.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

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

const DIRECTIVE_BUDGET_FRACTION = 0.25;

export async function layer4Gsd(ctx: PipelineContext): Promise<PipelineContext> {
  // Short-circuit: chitchat / pure-greeting inputs (detected by layer1) should
  // NOT be wrapped in a GSD directive. Injecting "STANDARD task — apply
  // GSD-quick mindset" onto "hi" forces the model into tool-using mode and
  // wastes both prompt budget and the user's wait.
  if (ctx.intentKind === "chitchat") {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "gsd-workflow-structuring", applied: false, delta: "skip:chitchat" }],
    };
  }

  let phase: GsdPhase | null = (ctx.gsdPhase as GsdPhase) ?? null;
  let routeSource = "preset";

  // Skip brain routeTask when L1's unified call already supplied brain data:
  // any phase L1 derived is already on ctx.gsdPhase, and a separate routeTask
  // round-trip would duplicate the brain hit the unified endpoint replaces.
  if (!phase && !ctx._brainData) {
    const eeRoute = await routeTask(ctx.raw).catch(() => null);
    if (eeRoute?.route && !eeRoute.needs_disambiguation && eeRoute.confidence >= 0.6) {
      phase = mapRouteToPhase(eeRoute.route);
      routeSource = `ee:${eeRoute.source}`;
    }
  } else if (ctx._brainData) {
    routeSource = "unified";
  }

  if (!phase) {
    phase = detectGsdPhase(ctx.raw);
    routeSource = phase ? "keyword" : "none";
  }

  const complexity = scoreComplexity(ctx.raw);
  const grayAreas = complexity.tier === "heavy" ? detectGrayAreas(ctx.raw).questions : [];
  const directive = buildDirective({ complexity, phase, grayAreas });

  const budgetChars = Math.floor(ctx.tokenBudget * DIRECTIVE_BUDGET_FRACTION);
  const trimmed = truncateToBudget(directive.text, budgetChars);

  return {
    ...ctx,
    gsdPhase: phase,
    complexityTier: complexity.tier,
    grayAreas,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "gsd-workflow-structuring",
        applied: true,
        delta: [
          `tier=${directive.tier}`,
          `score=${complexity.score}`,
          `phase=${phase ?? "none"}`,
          `route=${routeSource}`,
          `gray=${grayAreas.length}`,
          `blocking=${directive.blocking}`,
          `chars=${trimmed.length}`,
        ].join(" "),
      },
    ],
  };
}
