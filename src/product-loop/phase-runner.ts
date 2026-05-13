import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { CustomerDecision, PhasePlanState, PhaseStatus } from "./types.js";

function runDir(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId);
}

async function readPhasePlanState(flowDir: string, runId: string): Promise<PhasePlanState> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase Plan State");
  if (!raw) {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
  try {
    return JSON.parse(raw) as PhasePlanState;
  } catch {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
}

async function writePhasePlanState(flowDir: string, runId: string, state: PhasePlanState): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Phase Plan State", JSON.stringify(state, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markPhaseStatus(
  flowDir: string,
  runId: string,
  phaseId: string,
  status: PhaseStatus,
): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  if (state.phasesStatus[phaseId] === status) return;
  state.phasesStatus[phaseId] = status;
  state.currentPhaseId = status === "in-progress" ? phaseId : state.currentPhaseId;
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readPhaseStatus(flowDir: string, runId: string, phaseId: string): Promise<PhaseStatus | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.phasesStatus[phaseId] ?? null;
}

export async function markAwaitingCustomerReview(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearAwaitingCustomerReview(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markRetroPending(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`retro-pending:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearRetroPending(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`retro-pending:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function appendCustomerDecision(
  flowDir: string,
  runId: string,
  partial: Omit<CustomerDecision, "seq" | "timestampUtc"> & { phaseId: string; sprintN: number },
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Customer Decisions");
  let items: CustomerDecision[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version: 1; items: CustomerDecision[] };
      items = parsed.items ?? [];
    } catch {
      items = [];
    }
  }
  const seq = items.reduce((m, d) => Math.max(m, d.seq), 0) + 1;
  let feedback = partial.feedback;
  if (feedback && feedback.length > 2000) {
    feedback = feedback.slice(0, 2000) + "\n[…feedback truncated; full text in iterations.md]";
  }
  items.push({
    seq,
    timestampUtc: new Date().toISOString(),
    phaseId: partial.phaseId,
    sprintN: partial.sprintN,
    verdict: partial.verdict,
    feedback,
  });
  map.sections.set("Customer Decisions", JSON.stringify({ version: 1, items }, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function updateLastActivity(flowDir: string, runId: string): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readLastActivity(flowDir: string, runId: string): Promise<string | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.lastActivityUtc || null;
}

export async function collectStuckPhases(flowDir: string, runId: string): Promise<string[]> {
  const state = await readPhasePlanState(flowDir, runId);
  return Object.entries(state.phasesStatus)
    .filter(([_, s]) => s === "blocked" || s === "pending")
    .map(([id]) => id);
}
