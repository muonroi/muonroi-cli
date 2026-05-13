// src/product-loop/discovery-persistence.ts
import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { DiscoveryContext, DiscoveryState, ProjectContext, UserOverrideEntry } from "./types.js";

const SECTION = "Discovery";

export interface InitOpts {
  classification: DiscoveryState["classification"];
  prefillSource: DiscoveryState["prefillSource"];
  prefillAnswers?: Partial<DiscoveryContext>;
}

function runDir(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId);
}

export async function readDiscoveryState(flowDir: string, runId: string): Promise<DiscoveryState | null> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get(SECTION);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DiscoveryState;
  } catch {
    return null;
  }
}

async function writeDiscoveryState(flowDir: string, runId: string, state: DiscoveryState): Promise<void> {
  const dir = runDir(flowDir, runId);
  const map = (await readArtifact(dir, "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(SECTION, JSON.stringify(state, null, 2));
  await writeArtifact(dir, "state.md", map);
}

export async function initDiscoveryState(flowDir: string, runId: string, opts: InitOpts): Promise<void> {
  const existing = await readDiscoveryState(flowDir, runId);
  if (existing) return;
  const state: DiscoveryState = {
    version: 1,
    phase: "interview",
    classification: opts.classification,
    prefillSource: opts.prefillSource,
    questionsAsked: [],
    questionsAnswered: [],
    currentQuestion: undefined,
    answers: opts.prefillAnswers ?? {},
    recommendations: {},
    userOverrides: [],
    userGatePassed: false,
    cumulativeRecommenderCostUsd: 0,
  };
  await writeDiscoveryState(flowDir, runId, state);
}

export async function saveDiscoveryAnswer(
  flowDir: string,
  runId: string,
  questionId: string,
  value: any,
): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) throw new Error("discovery state not initialized");
  (state.answers as any)[questionId] = value;
  if (!state.questionsAnswered.includes(questionId)) {
    state.questionsAnswered.push(questionId);
  }
  if (!state.questionsAsked.includes(questionId)) {
    state.questionsAsked.push(questionId);
  }
  state.currentQuestion = undefined;
  await writeDiscoveryState(flowDir, runId, state);
}

export async function appendUserOverride(
  flowDir: string,
  runId: string,
  field: string,
  from: any,
  to: any,
  reason: string,
): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) throw new Error("discovery state not initialized");
  const nextSeq = state.userOverrides.length === 0 ? 1 : Math.max(...state.userOverrides.map((o) => o.seq)) + 1;
  const entry: UserOverrideEntry = {
    seq: nextSeq,
    timestampUtc: new Date().toISOString(),
    field,
    from,
    to,
    reason,
  };
  state.userOverrides.push(entry);
  await writeDiscoveryState(flowDir, runId, state);
}

export async function recordRecommendation(
  flowDir: string,
  runId: string,
  field: string,
  rec: DiscoveryState["recommendations"][string],
  costUsd: number,
): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) throw new Error("discovery state not initialized");
  state.recommendations[field] = rec;
  state.cumulativeRecommenderCostUsd += costUsd;
  await writeDiscoveryState(flowDir, runId, state);
}

export async function markUserGatePassed(flowDir: string, runId: string): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) throw new Error("discovery state not initialized");
  state.userGatePassed = true;
  state.phase = "awaiting-artifact-write";
  await writeDiscoveryState(flowDir, runId, state);
}

export async function markDone(flowDir: string, runId: string): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) throw new Error("discovery state not initialized");
  state.phase = "done";
  await writeDiscoveryState(flowDir, runId, state);
}
