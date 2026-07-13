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
  /** Verify verdict for this sprint (PASS/FAIL/ERROR) — grounds the review so it
   * describes what actually happened instead of confabulating an agile narrative. */
  verifyVerdict?: string;
}

const REVIEW_FLOOR_FRACTION = 0.01;
const REVIEW_FLOOR_MIN = 0.12;
const STANDUP_FLOOR_FRACTION = 0.04;
const STANDUP_FLOOR_MIN = 0.6;

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

export const STANDUP_HARD_CAP = 3;

async function readStandupCount(flowDir: string, runId: string): Promise<number> {
  const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
  const raw = map?.sections.get("Standup Count");
  if (!raw) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function standupFloor(capUsd: number): number {
  return Math.max(STANDUP_FLOOR_MIN, STANDUP_FLOOR_FRACTION * capUsd);
}

export async function runStandup(args: {
  flowDir: string;
  runId: string;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<StandupOutcome | null> {
  if (args.remainingUsd < standupFloor(args.capUsd)) return null;
  const prior = await readStandupCount(args.flowDir, args.runId);
  if (prior >= STANDUP_HARD_CAP) return null;

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
  } catch {
    return null;
  }
}
