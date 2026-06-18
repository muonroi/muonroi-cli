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
import type { GsdPhase } from "../gsd/types.js";
import type { ComplexityTier } from "../playbook/complexity.js";
import { buildDirective } from "../playbook/directives.js";
import { classifyEeError, logEeFailure } from "../utils/ee-logger.js";
import { truncateToBudget } from "./budget.js";
import { isImplementationIntent, isMetaAnalysisPrompt, isQuestionLike } from "./layer6-output.js";
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
// The playbook directive is a CRITICAL behavioural instruction, not enrichment
// context — it must reach the model INTACT. With the pipeline default
// tokenBudget=500, a 25% share is only ~125 tokens (~500 chars), which silently
// truncated the HEAVY rubric after the first step (CHECK-PLAN / IMPLEMENT /
// VERIFY / the todo_write checklist instruction never reached the model). The
// full HEAVY directive is ~1.7K chars, so floor the directive's own budget at a
// value that fits it whole (truncateToBudget multiplies by CHARS_PER_TOKEN=4 →
// 700 tokens ≈ 2.8K chars). The fraction still wins when tokenBudget is large.
const DIRECTIVE_MIN_TOKENS = 700;

// TODO(WhoAmI-L4): when EE v4.0 Who Am I profile is available:
//   - work_patterns.delegation_style="autonomous" → bias routeTask toward "direct",
//     skip qc-flow discussion phase for familiar task types
//   - decision_speed="fast-intuitive" → trim heavy-tier directive text,
//     remove "consider alternatives" section
//   - Cache routeTask result per (taskType, domain) in the profile so the
//     EE brain round-trip is skipped for patterns the user has confirmed before

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
    const eeRoute = await routeTask(ctx.raw).catch((err) => {
      logEeFailure("pil.layer4.routeTask", classifyEeError(err), err);
      return null;
    });
    if (eeRoute?.route && !eeRoute.needs_disambiguation && eeRoute.confidence >= 0.6) {
      phase = mapRouteToPhase(eeRoute.route);
      routeSource = `ee:${eeRoute.source}`;
    }
  } else if (ctx._brainData) {
    routeSource = "unified";
  }

  if (!phase) {
    // Agent-first: phase is a minor hint sourced from the EE brain only. We do
    // NOT keyword-regex it from the raw prompt — regex misclassification here
    // would mislabel the directive (no-regex rule, 2026-06-18). null is fine:
    // the directive reads cleanly without a phase hint.
    routeSource = "none";
  }

  // Work depth is decided by the model in layer1's classify call (the 5th
  // word → ctx.modelDepthTier). The regex `scoreComplexity` scorer has been
  // removed from this decision path: depth must reflect what the task actually
  // entails, not which keywords it contains. When the model classifier is
  // unwired/failed (modelDepthTier null — rare, since it IS the chat model),
  // default to the safe middle tier; the injected rubric still lets the agent
  // self-select up or down.
  const tier: ComplexityTier = ctx.modelDepthTier ?? "standard";
  // Gray areas are no longer pre-computed by regex. The HEAVY rubric instructs
  // the agent to surface its own clarifying questions via AskUserQuestion,
  // grounded in what it actually finds — far more accurate than keyword guesses.
  const grayAreas: never[] = [];
  // Informational prompts (a question / explanation / self-eval) ask for an
  // ANSWER, not a code change. The implement/verify directive otherwise leaks
  // into the human-facing reply as a "2-3 line plan" + process narration
  // (session 829a83888dd2). Route them to the human-facing question directive.
  //
  // Phase 2b: when the model classified the deliverable, CONSUME it. Both an
  // "answer" AND a "report" deliverable are HUMAN-FACING with no code change, so
  // both are informational — only "code" routes through the implement/verify (and
  // heavy discuss/council) scaffold. Treating "report" as non-informational sent
  // read/summarize/architecture tasks (deliverableKind "report") down the heavy
  // council + AskUserQuestion path, over-asking on a task that just wanted a
  // written summary (session 666630479c1a: "Đọc và tóm tắt kiến trúc…" raised 2
  // askcards + a council loop). Only when the model emitted no deliverable
  // (deliverableKind null → legacy cascade) do we fall back to regex predicates:
  //   1. isMetaAnalysisPrompt — self/CLI evaluation, prior-turn reflection.
  //   2. taskType "general" classified as a real task by L1.
  //   3. question-shaped prompt that is NOT an implementation request.
  const informational = ctx.deliverableKind
    ? ctx.deliverableKind !== "code"
    : isMetaAnalysisPrompt(ctx.raw) ||
      (ctx.taskType === "general" && ctx.intentKind === "task") ||
      (isQuestionLike(ctx.raw) && !isImplementationIntent(ctx.raw));
  // Scope + reply-language are now agent-first (model-decided in layer1's
  // classify call), NOT regex scans of the raw prompt (no-regex rule,
  // 2026-06-18). The ecosystem docs-first nudge fires only when the model judged
  // the turn platform-scoped; the language re-anchor fires for any non-English
  // language the model detected (the old regex only caught Vietnamese).
  const ecosystem = ctx.ecosystemScope === true;
  const replyLanguage = ctx.replyLanguage ?? undefined;
  const directive = buildDirective({ tier, phase, informational, ecosystem, replyLanguage });

  // truncateToBudget takes a TOKEN budget (×CHARS_PER_TOKEN internally). Floor it
  // at DIRECTIVE_MIN_TOKENS so the full directive always survives, even at the
  // default tokenBudget=500 where the bare fraction would gut it.
  const directiveTokenBudget = Math.max(Math.floor(ctx.tokenBudget * DIRECTIVE_BUDGET_FRACTION), DIRECTIVE_MIN_TOKENS);
  const trimmed = truncateToBudget(directive.text, directiveTokenBudget);
  const depthSource = ctx.modelDepthTier ? "model" : "default";

  return {
    ...ctx,
    gsdPhase: phase,
    complexityTier: tier,
    grayAreas,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "gsd-workflow-structuring",
        applied: true,
        delta: [
          `tier=${directive.tier}`,
          `depth=${depthSource}`,
          `phase=${phase ?? "none"}`,
          `route=${routeSource}`,
          `blocking=${directive.blocking}`,
          `chars=${trimmed.length}`,
        ].join(" "),
      },
    ],
  };
}
