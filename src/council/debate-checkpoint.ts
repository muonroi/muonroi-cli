/**
 * src/council/debate-checkpoint.ts
 *
 * C (mid-debate checkpoint) — persist the CB-1 council debate's per-round state
 * so a break mid-debate (provider 5xx on round 5, host crash, cap breach) can
 * resume from the last completed round instead of re-running the whole debate.
 *
 * The debate accumulates all state in RAM (`exchangeLogs`, `active`,
 * `runningSummary`, `archive`, convergence trackers). Without a checkpoint a
 * break loses every round — a 5-round multi-provider debate must restart from
 * round 1. This module owns the on-disk snapshot: `runDebate` writes it after
 * each completed round and deletes it on normal completion; the resume path
 * reads it and seeds `runDebate` so it skips research + openings + completed
 * rounds.
 *
 * File: `<checkpointDir>/debate-checkpoint.json` (checkpointDir = the run dir,
 * `.muonroi-flow/runs/<runId>`). Written atomically (tmp + rename) so a crash
 * mid-write can never leave a half-JSON file.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ClarifiedSpec, CouncilParticipant, DebateArchiveEntry } from "./types.js";

/** Bump when the checkpoint shape changes incompatibly so stale files are ignored. */
export const DEBATE_CHECKPOINT_VERSION = 1 as const;

export const DEBATE_CHECKPOINT_FILE = "debate-checkpoint.json";

/**
 * Serializable snapshot of an in-flight debate, written after each completed
 * discussion round. `exchangeLogs` (a `Map`) is stored as entry tuples since
 * JSON has no Map; everything else in the payload is already JSON-native.
 */
export interface DebateCheckpoint {
  version: typeof DEBATE_CHECKPOINT_VERSION;
  /**
   * Identity guard — the checkpoint is only restored when it matches the debate
   * about to run. `problemStatement` pins the spec; `participantModels` pins the
   * panel. A mismatch (spec changed, panel re-resolved differently) => ignore
   * the stale checkpoint and run the debate fresh rather than splice wrong state.
   */
  problemStatement: string;
  participantModels: string[];
  /** Rounds fully completed (transcript + summary persisted). Resume starts at roundCount+1. */
  roundCount: number;
  /** Current round budget after any leader/user extensions. */
  maxRounds: number;
  /** Accumulated per-pair transcript (Map<pairKey, turns[]> serialized as entries). */
  exchangeLogs: Array<[string, string[]]>;
  /** Latest inter-round summary. */
  runningSummary: string;
  /** Research findings (so the research phase is not re-run on resume). */
  researchFindings?: string;
  /** Surviving participants with their latest position + stance (so openings are not re-run). */
  active: CouncilParticipant[];
  /** Citation archive accumulated so far. */
  archive: DebateArchiveEntry[];
  /** Convergence continuity: last round's per-criterion met flags. */
  lastCriteriaMet: boolean[];
  /** B4 auto-remedy high-water mark of pinned criteria met. */
  bestCriteriaMetCount: number;
  /** B4 consecutive evaluated rounds with no new met criterion. */
  roundsSinceProgress: number;
  /** Topic carried into the next round from the prior leader nextRoundFocus. */
  nextTopic?: string;
  /** Wall-clock the checkpoint was written (ISO). Diagnostics only. */
  savedAt: string;
}

/** Input to {@link buildDebateCheckpoint} — the live round-loop locals. */
export interface DebateCheckpointInput {
  problemStatement: string;
  roundCount: number;
  maxRounds: number;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  researchFindings?: string;
  active: CouncilParticipant[];
  archive: DebateArchiveEntry[];
  lastCriteriaMet: boolean[];
  bestCriteriaMetCount: number;
  roundsSinceProgress: number;
  nextTopic?: string;
  /** ISO timestamp; the caller supplies it (Date.now is unavailable in some sandboxes). */
  savedAt: string;
}

/** Build the serializable checkpoint payload from live debate state. */
export function buildDebateCheckpoint(input: DebateCheckpointInput): DebateCheckpoint {
  return {
    version: DEBATE_CHECKPOINT_VERSION,
    problemStatement: input.problemStatement,
    participantModels: input.active.map((p) => p.model),
    roundCount: input.roundCount,
    maxRounds: input.maxRounds,
    exchangeLogs: [...input.exchangeLogs.entries()].map(([k, v]) => [k, [...v]] as [string, string[]]),
    runningSummary: input.runningSummary,
    researchFindings: input.researchFindings,
    active: input.active,
    archive: input.archive,
    lastCriteriaMet: [...input.lastCriteriaMet],
    bestCriteriaMetCount: input.bestCriteriaMetCount,
    roundsSinceProgress: input.roundsSinceProgress,
    nextTopic: input.nextTopic,
    savedAt: input.savedAt,
  };
}

/** Rehydrate `exchangeLogs` from the serialized entry tuples. */
export function restoreExchangeLogs(cp: DebateCheckpoint): Map<string, string[]> {
  return new Map(cp.exchangeLogs.map(([k, v]) => [k, [...v]]));
}

/**
 * Whether `cp` describes the debate that is about to run. Guards against
 * splicing a stale checkpoint (different question, re-resolved panel) into a
 * fresh debate. Participant order is not significant; the model SET must match.
 */
export function checkpointMatches(
  cp: DebateCheckpoint,
  problemStatement: string,
  participantModels: string[],
): boolean {
  if (cp.version !== DEBATE_CHECKPOINT_VERSION) return false;
  if (cp.roundCount < 1) return false; // nothing useful to resume from
  if (cp.problemStatement !== problemStatement) return false;
  const a = [...cp.participantModels].sort();
  const b = [...participantModels].sort();
  if (a.length !== b.length) return false;
  return a.every((m, i) => m === b[i]);
}

/**
 * Atomically write the checkpoint to `<dir>/debate-checkpoint.json`.
 * Non-fatal: a checkpoint write failure must never break the live debate — it
 * only forfeits resumability for that round. Logs with context (No-Silent-Catch).
 */
export async function writeDebateCheckpoint(dir: string, cp: DebateCheckpoint): Promise<void> {
  const finalPath = path.join(dir, DEBATE_CHECKPOINT_FILE);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(cp), "utf8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    console.error(`[debate-checkpoint] write failed (dir=${dir}, round=${cp.roundCount}): ${(err as Error)?.message}`);
    // Best-effort cleanup of the temp file; ignore if it never got created.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Read + parse the checkpoint. Returns null when absent or unparseable (a
 * corrupt checkpoint must not crash resume — the debate just runs fresh).
 */
export async function readDebateCheckpoint(dir: string): Promise<DebateCheckpoint | null> {
  const finalPath = path.join(dir, DEBATE_CHECKPOINT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(finalPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[debate-checkpoint] read failed (dir=${dir}): ${(err as Error)?.message}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DebateCheckpoint;
    if (parsed?.version !== DEBATE_CHECKPOINT_VERSION) return null;
    return parsed;
  } catch (err) {
    console.error(`[debate-checkpoint] parse failed (dir=${dir}): ${(err as Error)?.message}`);
    return null;
  }
}

/**
 * Delete the checkpoint (debate completed normally, or the run was aborted).
 * Non-fatal — a leftover checkpoint is only re-validated (and discarded on
 * mismatch) on the next resume, never silently mis-applied.
 */
export async function deleteDebateCheckpoint(dir: string): Promise<void> {
  const finalPath = path.join(dir, DEBATE_CHECKPOINT_FILE);
  try {
    await fs.rm(finalPath, { force: true });
  } catch (err) {
    console.error(`[debate-checkpoint] delete failed (dir=${dir}): ${(err as Error)?.message}`);
  }
}

// ── Debate inputs (C-v2 cross-session resume) ────────────────────────────────

export const DEBATE_INPUTS_FILE = "debate-inputs.json";

/**
 * C-v2 — the minimal gather-stage outputs needed to re-enter the council debate
 * on a fresh session (cross-process resume) WITHOUT re-running the interactive
 * discovery + interview. Persisted once at debate start; the loop-driver resume
 * entry restores `clarifiedSpec` + `conversationContext` and jumps straight to
 * the research/debate stage (participants + leader are re-resolved from the
 * session model deterministically, then matched against the checkpoint panel).
 */
export interface DebateInputs {
  version: typeof DEBATE_CHECKPOINT_VERSION;
  problemStatement: string;
  clarifiedSpec: ClarifiedSpec;
  conversationContext: string;
  savedAt: string;
}

/** Atomically persist the debate inputs. Non-fatal on failure (forfeits cross-session resume only). */
export async function writeDebateInputs(dir: string, inputs: DebateInputs): Promise<void> {
  const finalPath = path.join(dir, DEBATE_INPUTS_FILE);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(inputs), "utf8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    console.error(`[debate-checkpoint] inputs write failed (dir=${dir}): ${(err as Error)?.message}`);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Read the debate inputs. Returns null when absent/unparseable/version-mismatched. */
export async function readDebateInputs(dir: string): Promise<DebateInputs | null> {
  const finalPath = path.join(dir, DEBATE_INPUTS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(finalPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[debate-checkpoint] inputs read failed (dir=${dir}): ${(err as Error)?.message}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DebateInputs;
    if (parsed?.version !== DEBATE_CHECKPOINT_VERSION) return null;
    return parsed;
  } catch (err) {
    console.error(`[debate-checkpoint] inputs parse failed (dir=${dir}): ${(err as Error)?.message}`);
    return null;
  }
}

/** Delete the debate inputs (debate + scoping finished, or run aborted). Non-fatal. */
export async function deleteDebateInputs(dir: string): Promise<void> {
  try {
    await fs.rm(path.join(dir, DEBATE_INPUTS_FILE), { force: true });
  } catch (err) {
    console.error(`[debate-checkpoint] inputs delete failed (dir=${dir}): ${(err as Error)?.message}`);
  }
}
