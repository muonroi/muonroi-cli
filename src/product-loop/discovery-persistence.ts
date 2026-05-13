// src/product-loop/discovery-persistence.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { readProjectContextWithMigration } from "./discovery-migrations.js";
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

const ARTIFACT_SECTION = "Project Context";

export function buildProjectContextFromState(
  state: DiscoveryState,
  idea: string,
  detection: ProjectContext["detection"],
): ProjectContext {
  const recsByField: ProjectContext["recommendations"]["byField"] = {};
  for (const [field, rec] of Object.entries(state.recommendations)) {
    recsByField[field] = {
      chosen: rec.chosen,
      alternatives: rec.alternatives,
      rationale: rec.rationale,
      source: rec.source,
      debateRef: rec.debateRef,
      tiebreakUsed: rec.tiebreakUsed,
      synthFailed: rec.synthFailed,
    };
  }
  return {
    version: 1,
    schemaName: "project-context",
    generatedAt: new Date().toISOString(),
    idea,
    detection,
    context: state.answers as ProjectContext["context"],
    recommendations: {
      byField: recsByField,
      constraints: { fePolicy: "headless-ui-only", feEnforced: true },
    },
    userOverrides: state.userOverrides,
  };
}

export async function writeProjectContext(flowDir: string, runId: string, ctx: ProjectContext): Promise<void> {
  const dir = runDir(flowDir, runId);
  const map = (await readArtifact(dir, "project-context.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(ARTIFACT_SECTION, JSON.stringify(ctx, null, 2));
  await writeArtifact(dir, "project-context.md", map);
}

export async function readProjectContext(flowDir: string, runId: string): Promise<ProjectContext | null> {
  const map = await readArtifact(runDir(flowDir, runId), "project-context.md");
  const raw = map?.sections.get(ARTIFACT_SECTION);
  if (!raw) return null;
  return readProjectContextWithMigration(raw);
}

export async function resumeArtifactWriteIfNeeded(
  flowDir: string,
  runId: string,
  idea: string,
  detection: ProjectContext["detection"],
): Promise<void> {
  const state = await readDiscoveryState(flowDir, runId);
  if (!state) return;
  if (state.phase === "done") return;
  if (state.phase !== "awaiting-artifact-write") return;
  const existing = await readProjectContext(flowDir, runId);
  if (!existing) {
    const ctx = buildProjectContextFromState(state, idea, detection);
    await writeProjectContext(flowDir, runId, ctx);
  }
  await markDone(flowDir, runId);
}

function lockPath(flowDir: string, runId: string): string {
  return path.join(runDir(flowDir, runId), ".discovery.lock");
}

export async function acquireRunLock(flowDir: string, runId: string): Promise<void> {
  const lock = lockPath(flowDir, runId);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    const fh = await fs.open(lock, "wx");
    await fh.writeFile(String(process.pid));
    await fh.close();
  } catch (err: any) {
    if (err?.code === "EEXIST") throw new Error(`run ${runId} is already running (lock held)`);
    throw err;
  }
}

export async function releaseRunLock(flowDir: string, runId: string): Promise<void> {
  try {
    await fs.unlink(lockPath(flowDir, runId));
  } catch {
    /* idempotent */
  }
}
