/**
 * src/pil/session-experience-injection.ts
 *
 * Felt-experience routing. When the user asks how the agent is *doing* inside
 * this CLI session — "cảm nhận trong CLI", "bạn có bị mù context không",
 * "how do you feel working in here", "did you struggle" — the agent should
 * answer from what ACTUALLY happened to it this session, not by reading the
 * compaction/PIL source and theorizing about mechanisms (the backwards behaviour
 * in session ce816796a57d: no compaction fired, no ee_query call, no blindness —
 * yet the agent answered by grepping the anti-mù code).
 *
 * This step injects the live session-experience snapshot into the enriched
 * prompt and tells the agent to ground its answer in that data. It is narrow on
 * purpose: a generic "đánh giá / cải thiện CLI" evaluation still goes the
 * code-reading route — only first-person *experience* questions get the snapshot.
 *
 * Pure, synchronous, additive, fail-open: records a `session-experience` layer
 * marker either way for forensics.
 */

import { formatSessionExperience } from "../orchestrator/session-experience.js";
import type { PipelineContext } from "./types.js";

/**
 * Narrow detector for "how do you (the agent) feel / are you blind / did you
 * struggle in this session" questions. Deliberately keyed on introspective
 * vocabulary (feeling / experience / blind / struggle) rather than the broad
 * meta-analysis regex, so plain "evaluate the CLI" prompts are NOT captured.
 */
export const SELF_EXPERIENCE_RE =
  /cảm nhận|cảm thấy|cảm giác|trải nghiệm|(bị\s*)?mù\s*context|bị\s*mù|how (do|does) (you|it) feel|how are you (doing|feeling)|your (own |felt )?experience|are you (feeling\s+)?blind|do you feel blind|did you (struggle|have (a |any )?(trouble|difficulty|hard time|problem))|có (gặp\s+)?khó khăn|gặp (vấn đề|khó khăn)/i;

export function isSelfExperiencePrompt(raw: string): boolean {
  return typeof raw === "string" && SELF_EXPERIENCE_RE.test(raw);
}

const MARKER = "[session experience —";

/**
 * Append the live session-experience snapshot when the prompt is a first-person
 * experience question. No-op (but marker-recorded) otherwise, and idempotent if
 * the snapshot is already present.
 */
export function injectSessionExperience(ctx: PipelineContext): PipelineContext {
  const mark = (applied: boolean, delta: string): PipelineContext => ({
    ...ctx,
    layers: [...ctx.layers, { name: "session-experience", applied, delta }],
  });

  if (!isSelfExperiencePrompt(ctx.raw)) return mark(false, "not-self-experience");
  if (ctx.enriched.includes(MARKER)) return mark(false, "already-injected");

  const snapshot = formatSessionExperience();
  const block = `\n${snapshot}`;
  return {
    ...ctx,
    enriched: `${ctx.enriched}${block}`,
    layers: [...ctx.layers, { name: "session-experience", applied: true, delta: `chars=${block.length}` }],
  };
}
