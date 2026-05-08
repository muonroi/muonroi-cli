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
 * Noise threshold: matches below this confidence are treated as noise
 * and should not strengthen the principle via FOLLOWED classification.
 */
export const NOISE_CONFIDENCE_THRESHOLD = 0.3;

/**
 * Deterministic classification rules (from RESEARCH Auto-Judge Deterministic Rules):
 *
 * 1. No matches or cwd mismatch → IRRELEVANT
 * 2. Outcome failed → IGNORED
 * 3. Any match has expectedBehavior='should-not-edit' AND diff present → IGNORED
 * 4. All matches below noise threshold → IRRELEVANT (prevents noise reinforcement)
 * 5. Otherwise → FOLLOWED
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
  if (ctx.warningResponse.matches.every((m) => m.confidence < NOISE_CONFIDENCE_THRESHOLD)) {
    return "IRRELEVANT";
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

export interface CouncilJudgeResult {
  confidence: number;   // 0–1
  verdict: "pass" | "fail" | "needs_review";
  reason: string;
}

/**
 * Judge a council synthesis for quality using heuristic scoring.
 * No LLM involved — deterministic rules based on synthesis content.
 * confidence < 0.5 → verdict=needs_review.
 * Fire-and-forget pattern: callers use .then() not await.
 * Never throws — fail-open B-4 compliant.
 */
export async function judgeCouncilOutcome(synthesis: string): Promise<CouncilJudgeResult> {
  try {
    // Heuristic scoring (deterministic — no LLM):
    // +0.3 for synthesis length >= 200 chars (substantive)
    // +0.2 for at least one citation pattern ([file:], [url], [REFUTED via])
    // +0.2 for recommended action present (look for "Recommendation" or "recommend")
    // +0.15 for convergence signal ("agreed", "consensus", "all participants")
    // +0.15 for evidence density (>= 2 citation patterns)
    let score = 0.0;
    const len = synthesis.length;
    const lc = synthesis.toLowerCase();
    const citationCount = (synthesis.match(/\[(?:file:|url|snapshot:|REFUTED via)/g) ?? []).length;

    if (len >= 200) score += 0.3;
    if (citationCount >= 1) score += 0.2;
    if (lc.includes("recommend")) score += 0.2;
    if (lc.includes("agreed") || lc.includes("consensus")) score += 0.15;
    if (citationCount >= 2) score += 0.15;

    const confidence = Math.min(1.0, Math.max(0.0, score));

    return {
      confidence,
      verdict: confidence < 0.5 ? "needs_review" : "pass",
      reason: `heuristic: len=${len} citations=${citationCount} score=${score.toFixed(2)}`,
    };
  } catch (err) {
    return { confidence: 0, verdict: "needs_review", reason: `error: ${(err as Error).message}` };
  }
}
