/**
 * src/ee/judge.ts
 *
 * Deterministic auto-judge classifier (EE-09).
 * Classifies every tool call as FOLLOWED | IGNORED | IRRELEVANT using
 * deterministic rules — no LLM involved.
 *
 * fireFeedback() fires /api/feedback fire-and-forget per match, and
 * /api/principle/touch on FOLLOWED matches (EE-10 decay refresh).
 */

import { getDefaultEEClient } from "./intercept.js";
import type { Classification, InterceptResponse, PostToolPayload } from "./types.js";

export interface JudgeContext {
  warningResponse: InterceptResponse | null;
  toolName: string;
  outcome: PostToolPayload["outcome"];
  cwdMatchedAtPretool: boolean;
  diffPresent: boolean;
  tenantId: string;
}

/**
 * Deterministic classification rules (from RESEARCH Auto-Judge Deterministic Rules):
 *
 * 1. No matches or cwd mismatch → IRRELEVANT
 * 2. Outcome failed → IGNORED
 * 3. Any match has expectedBehavior='should-not-edit' AND diff present → IGNORED
 * 4. Otherwise → FOLLOWED
 */
export function judge(ctx: JudgeContext): Classification {
  if (!ctx.warningResponse?.matches?.length || !ctx.cwdMatchedAtPretool) {
    return "IRRELEVANT";
  }
  if (!ctx.outcome.success) {
    return "IGNORED";
  }
  if (ctx.warningResponse.matches.some((m) => m.expectedBehavior === "should-not-edit" && ctx.diffPresent)) {
    return "IGNORED";
  }
  return "FOLLOWED";
}

/**
 * Fire feedback for each match in the warning response.
 * - Always calls /api/feedback per match (fire-and-forget).
 * - On FOLLOWED, also calls /api/principle/touch per match (EE-10 decay refresh).
 *
 * B-4 invariant: returns void synchronously. All HTTP calls are fire-and-forget.
 */
export function fireFeedback(ctx: JudgeContext): void {
  const cls = judge(ctx);
  const matches = ctx.warningResponse?.matches ?? [];
  const client = getDefaultEEClient();
  for (const m of matches) {
    client.feedback({
      principle_uuid: m.principle_uuid,
      classification: cls,
      tool_name: ctx.toolName,
      duration_ms: ctx.outcome.durationMs ?? 0,
      tenantId: ctx.tenantId,
    });
    if (cls === "FOLLOWED") {
      client.touch(m.principle_uuid, ctx.tenantId);
    }
  }
}
