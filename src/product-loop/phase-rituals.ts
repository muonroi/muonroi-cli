import * as path from "node:path";
import { readArtifact } from "../flow/artifact-io.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { withRateLimitBackoff } from "./discovery-recommender.js";
import type { LessonsLearned, Phase, PhasePlanState, StandupOutcome } from "./types.js";

export interface SprintState {
  sprintN: number;
  scoreBefore: number;
  scoreAfter: number;
  criteriaMet: number;
  totalCriteria: number;
}

const REVIEW_FLOOR_FRACTION = 0.01;
const REVIEW_FLOOR_MIN = 0.12;
const _STANDUP_FLOOR_FRACTION = 0.04;
const _STANDUP_FLOOR_MIN = 0.6;

function reviewFloor(capUsd: number): number {
  return Math.max(REVIEW_FLOOR_MIN, REVIEW_FLOOR_FRACTION * capUsd);
}

function deterministicReview(s: SprintState): string {
  return `Sprint ${s.sprintN}: score ${s.scoreBefore.toFixed(2)}→${s.scoreAfter.toFixed(2)}, met ${s.criteriaMet}/${s.totalCriteria} criteria`;
}

export async function generateSprintReview(args: {
  sprintState: SprintState;
  phase: Phase;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<{ summary: string; usedFallback: boolean }> {
  if (args.remainingUsd < reviewFloor(args.capUsd)) {
    return { summary: deterministicReview(args.sprintState), usedFallback: true };
  }
  const prompt =
    `Sprint ${args.sprintState.sprintN} of phase ${args.phase.id}: score ${args.sprintState.scoreBefore.toFixed(2)} → ${args.sprintState.scoreAfter.toFixed(2)}, ` +
    `met ${args.sprintState.criteriaMet}/${args.sprintState.totalCriteria} criteria. ` +
    `Write a ≤500-char demo summary for the customer.`;
  try {
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You write concise sprint demo summaries.", prompt, maxTokens: 250 }),
      { delays: args.backoffDelays },
    );
    return { summary: res.content.trim().slice(0, 500), usedFallback: false };
  } catch {
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
  } catch {
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
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<LessonsLearned> {
  if (args.remainingUsd < reviewFloor(args.capUsd)) {
    throw new Error("RetroSkippedBudget");
  }
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

export async function runStandup(_args: {
  flowDir: string;
  runId: string;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<StandupOutcome | null> {
  // Stub - implemented in Task 9
  return null;
}
