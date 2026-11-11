/**
 * src/pil/reply-language.ts
 *
 * Host-owned reply language (P1). Layer 1's classify call detects the user's
 * language (llm-classify.ts: `replyLanguage`, null for English). The nudge
 * that re-anchors it (playbook/directives.ts buildLanguageNudge) used to reach
 * the model only on the legacy / informational layer-4 branch — the native
 * FLOW, plan-execution and chitchat paths, and every turn with a null
 * taskType (layer 4 skipped), carried nothing, so the rule lived as static
 * contract text re-sent on every call instead.
 *
 * Now the pipeline applies it on EVERY turn whose detected language is not
 * English, after all layers ran, and the static language lines are gone from
 * the worker contract. Idempotent: a turn whose layer-4 directive already
 * carries the nudge is left untouched.
 */
import { buildLanguageNudge } from "../playbook/directives.js";
import type { PipelineContext } from "./types.js";

export function applyReplyLanguageNudge(ctx: PipelineContext): PipelineContext {
  const lang = ctx.replyLanguage;
  if (!lang) return ctx;
  const nudge = buildLanguageNudge(lang);
  if (ctx.enriched.includes(nudge)) return ctx;
  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${nudge}`,
    layers: [...ctx.layers, { name: "reply-language", applied: true, delta: `lang=${lang}` }],
  };
}
