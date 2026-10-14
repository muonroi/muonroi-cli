import * as path from "node:path";
import { readArtifact } from "../flow/artifact-io.js";
import { logger } from "../utils/logger.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { withRateLimitBackoff } from "./discovery-recommender.js";
import type { LessonsLearned, Phase, PhasePlanState, StandupOutcome } from "./types.js";

/*
 * Sprint rituals (review / retro / standup).
 *
 * These calls used to be skipped when the run's remaining spend fell under a
 * floor derived from `--max-cost`, and standups were capped at 3 per run. Both
 * were budgets. `/ideal` has no limits (user decision), so every ritual runs; a
 * deterministic fallback is used only when the leader call itself fails.
 */

export interface SprintState {
  sprintN: number;
  scoreBefore: number;
  scoreAfter: number;
  criteriaMet: number;
  totalCriteria: number;
  /** Verify verdict for this sprint (PASS/FAIL/ERROR) — grounds the review so it
   * describes what actually happened instead of confabulating an agile narrative. */
  verifyVerdict?: string;
}

function deterministicReview(s: SprintState): string {
  return `Sprint ${s.sprintN}: score ${s.scoreBefore.toFixed(2)}→${s.scoreAfter.toFixed(2)}, met ${s.criteriaMet}/${s.totalCriteria} criteria`;
}

export async function generateSprintReview(args: {
  sprintState: SprintState;
  phase: Phase;
  leader: LeaderLike;
  backoffDelays?: number[];
}): Promise<{ summary: string; usedFallback: boolean }> {
  const s = args.sprintState;
  const verifyLine = s.verifyVerdict ? ` Verify: ${s.verifyVerdict}.` : "";
  const goal = args.phase.goal ? ` Phase goal: ${args.phase.goal}.` : "";
  const prompt =
    `Sprint ${s.sprintN} of phase ${args.phase.id}: score ${s.scoreBefore.toFixed(2)} → ${s.scoreAfter.toFixed(2)}, ` +
    `met ${s.criteriaMet}/${s.totalCriteria} acceptance criteria.${verifyLine}${goal} ` +
    `Write a ≤500-char demo summary describing ONLY what these numbers show — the concrete progress on criteria and verify status. ` +
    `Do NOT invent activities (e.g. "team alignment", "environment setup") that the metrics do not evidence. ` +
    `If 0/${s.totalCriteria} criteria are met, say plainly that no criteria passed yet and why (verify status), not that setup was done.`;
  try {
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You write concise sprint demo summaries.", prompt, maxTokens: 250 }),
      { delays: args.backoffDelays },
    );
    return { summary: res.content.trim().slice(0, 500), usedFallback: false };
  } catch (err) {
    logger.warn("orchestrator", "[rituals] sprint review leader call failed; using the deterministic summary", {
      sprintN: s.sprintN,
      phaseId: args.phase.id,
      message: (err as Error)?.message,
    });
    return { summary: deterministicReview(args.sprintState), usedFallback: true };
  }
}

export async function hasAnyPhaseInProgress(flowDir: string, runId: string): Promise<boolean> {
  const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
  const raw = map?.sections.get("Phase Plan State");
  if (!raw) return false;
  try {
    const state = JSON.parse(raw) as PhasePlanState;
    return Object.values(state.phasesStatus).includes("in-progress");
  } catch (err) {
    logger.warn("orchestrator", "[rituals] Phase Plan State is not valid JSON; treating no phase as in progress", {
      runId,
      message: (err as Error)?.message,
    });
    return false;
  }
}

export async function shouldRunStandup(
  lastActivityUtc: string | null,
  flowDir: string,
  runId: string,
): Promise<boolean> {
  if (!lastActivityUtc) return false;
  const elapsedMs = Date.now() - new Date(lastActivityUtc).getTime();
  if (elapsedMs <= 60 * 60 * 1000) return false;
  return await hasAnyPhaseInProgress(flowDir, runId);
}

export async function runRetro(args: {
  sprintState: SprintState;
  leader: LeaderLike;
  backoffDelays?: number[];
}): Promise<LessonsLearned> {
  const prompt =
    `Sprint ${args.sprintState.sprintN}: score ${args.sprintState.scoreBefore.toFixed(2)}→${args.sprintState.scoreAfter.toFixed(2)}, ` +
    `met ${args.sprintState.criteriaMet}/${args.sprintState.totalCriteria}. ` +
    `Output JSON: { wentWell: string[] (≤5, each ≤200 chars), toImprove: string[] (≤5, each ≤200), nextSprintFocus: string (≤300) }`;
  const res = await withRateLimitBackoff(
    () => args.leader.generate({ system: "You write concise retros as strict JSON.", prompt, maxTokens: 500 }),
    { delays: args.backoffDelays },
  );
  const parsed = JSON.parse(
    res.content
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "")
      .trim(),
  ) as LessonsLearned;
  const cap = (arr: string[], n: number, len: number) => arr.slice(0, n).map((s) => s.slice(0, len));
  return {
    wentWell: cap(parsed.wentWell ?? [], 5, 200),
    toImprove: cap(parsed.toImprove ?? [], 5, 200),
    nextSprintFocus: (parsed.nextSprintFocus ?? "").slice(0, 300),
  };
}

export async function runStandup(args: {
  flowDir: string;
  runId: string;
  leader: LeaderLike;
  backoffDelays?: number[];
}): Promise<StandupOutcome | null> {
  const prompt =
    `Daily standup. Output strict JSON: { blockers: string[] (≤5, ≤200 each), decisions: string[] (≤5, ≤200 each), nextStep: string (≤300) }. ` +
    `Be specific and decisive.`;
  try {
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You facilitate a council daily standup.", prompt, maxTokens: 600 }),
      { delays: args.backoffDelays },
    );
    const parsed = JSON.parse(
      res.content
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "")
        .trim(),
    ) as StandupOutcome;
    const cap = (arr: string[], n: number, len: number) => (arr ?? []).slice(0, n).map((s) => String(s).slice(0, len));
    return {
      blockers: cap(parsed.blockers, 5, 200),
      decisions: cap(parsed.decisions, 5, 200),
      nextStep: String(parsed.nextStep ?? "").slice(0, 300),
    };
  } catch (err) {
    logger.warn("orchestrator", "[rituals] standup failed; skipping this standup", {
      runId: args.runId,
      message: (err as Error)?.message,
    });
    return null;
  }
}
