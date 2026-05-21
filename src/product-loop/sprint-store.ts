/**
 * src/product-loop/sprint-store.ts
 *
 * Atomic read/write helpers for .planning/runs/<runId>/sprint-plan.json.
 * Mirrors backlog-store.ts — same atomicWriteJSON / atomicReadJSON helpers,
 * same patch semantics.
 */

import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "../storage/atomic-io.js";
import type { Sprint, SprintPlan } from "./types.js";

function sprintPlanPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "sprint-plan.json");
}

/**
 * Read sprint-plan.json for a run. Returns null when the file does not exist.
 */
export async function readSprintPlan(flowDir: string, runId: string): Promise<SprintPlan | null> {
  return atomicReadJSON<SprintPlan>(sprintPlanPath(flowDir, runId));
}

/**
 * Write (overwrite) sprint-plan.json atomically.
 */
export async function writeSprintPlan(flowDir: string, runId: string, plan: SprintPlan): Promise<void> {
  await atomicWriteJSON(sprintPlanPath(flowDir, runId), plan);
}

/**
 * Mark a sprint as active. If another sprint was already active, flip it to "done" first.
 * Sets startedAtUtc on the newly-active sprint and updates plan.activeSprintId.
 * Throws when sprint-plan.json is missing or the sprintId is not found.
 */
export async function setActiveSprint(flowDir: string, runId: string, sprintId: string): Promise<SprintPlan> {
  const plan = await readSprintPlan(flowDir, runId);
  if (!plan) {
    throw new Error(`setActiveSprint: sprint-plan.json not found for runId=${runId}`);
  }

  const targetIdx = plan.sprints.findIndex((s: Sprint) => s.id === sprintId);
  if (targetIdx === -1) {
    throw new Error(`setActiveSprint: sprint id=${sprintId} not found in plan for runId=${runId}`);
  }

  const now = new Date().toISOString();

  // Flip any currently-active sprint to done first.
  plan.sprints = plan.sprints.map((s: Sprint) => {
    if (s.status === "active" && s.id !== sprintId) {
      return { ...s, status: "done" as const, endedAtUtc: now };
    }
    return s;
  });

  plan.sprints[targetIdx] = {
    ...plan.sprints[targetIdx],
    status: "active",
    startedAtUtc: now,
  };
  plan.activeSprintId = sprintId;

  await writeSprintPlan(flowDir, runId, plan);
  return plan;
}

/**
 * Mark a sprint as done. Clears activeSprintId if it matched the given sprint.
 * Sets endedAtUtc. Throws when sprint-plan.json is missing or the sprintId is not found.
 */
export async function markSprintDone(flowDir: string, runId: string, sprintId: string): Promise<SprintPlan> {
  const plan = await readSprintPlan(flowDir, runId);
  if (!plan) {
    throw new Error(`markSprintDone: sprint-plan.json not found for runId=${runId}`);
  }

  const targetIdx = plan.sprints.findIndex((s: Sprint) => s.id === sprintId);
  if (targetIdx === -1) {
    throw new Error(`markSprintDone: sprint id=${sprintId} not found in plan for runId=${runId}`);
  }

  const now = new Date().toISOString();
  plan.sprints[targetIdx] = {
    ...plan.sprints[targetIdx],
    status: "done",
    endedAtUtc: now,
  };

  if (plan.activeSprintId === sprintId) {
    delete plan.activeSprintId;
  }

  await writeSprintPlan(flowDir, runId, plan);
  return plan;
}
