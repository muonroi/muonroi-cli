/**
 * src/product-loop/sprint-store.ts
 *
 * Atomic read/write helpers for .planning/runs/<runId>/sprint-plan.json.
 * Mirrors backlog-store.ts — same atomicWriteJSON / atomicReadJSON helpers,
 * same patch semantics.
 */

import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "../storage/atomic-io.js";
import type { Sprint, SprintPlan, SprintStatus, SprintVerdictRecord } from "./types.js";

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

export interface UpsertSprintPatch {
  goal?: string;
  itemIds?: string[];
  status?: SprintStatus;
  startedAtUtc?: string;
  endedAtUtc?: string;
  verdict?: SprintVerdictRecord;
}

/**
 * S1 — Insert or update a sprint entry in sprint-plan.json by sprint NUMBER,
 * without requiring the plan (or the entry) to already exist.
 *
 * `setActiveSprint` / `markSprintDone` both throw when sprint-plan.json is
 * missing or the id isn't found — correct for a plan built once up front,
 * but sprints are dynamic (feedback-routing / CB-2 can drive a sprint number
 * the initial `planSprints` bin-pack never predicted), so a plain
 * "update in place" primitive cannot register one of those. This is that
 * primitive: sprint-plan.json is created if missing, and a missing sprint
 * number is appended (using `patch.goal` when the caller has one — e.g. the
 * backlog-derived goal — and an honest placeholder otherwise; a goal is
 * NEVER invented). Re-running the same sprint number matches the existing
 * entry (by `number`, falling back to `id`) and updates it in place, so a
 * retried sprint never creates a duplicate row.
 *
 * `patch.status === "active"` flips any OTHER currently-active sprint to
 * "done" first, mirroring `setActiveSprint`'s existing behaviour, so
 * `activeSprintId` never points at two entries at once. Setting any other
 * status clears `activeSprintId` when it pointed at this sprint, mirroring
 * `markSprintDone`.
 */
export async function upsertSprint(
  flowDir: string,
  runId: string,
  sprintN: number,
  patch: UpsertSprintPatch,
): Promise<SprintPlan> {
  const existing = await readSprintPlan(flowDir, runId);
  const plan: SprintPlan = existing ?? { runId, sprints: [], createdAtUtc: new Date().toISOString() };
  const id = `sprint-${sprintN}`;
  const idx = plan.sprints.findIndex((s) => s.number === sprintN || s.id === id);

  if (idx === -1) {
    const created: Sprint = {
      id,
      number: sprintN,
      goal: patch.goal ?? "(goal not recorded — sprint was registered dynamically, outside the initial plan)",
      itemIds: patch.itemIds ?? [],
      status: patch.status ?? "planned",
    };
    if (patch.startedAtUtc !== undefined) created.startedAtUtc = patch.startedAtUtc;
    if (patch.endedAtUtc !== undefined) created.endedAtUtc = patch.endedAtUtc;
    if (patch.verdict !== undefined) created.verdict = patch.verdict;
    plan.sprints = [...plan.sprints, created];
  } else {
    const current = plan.sprints[idx]!;
    const updated: Sprint = { ...current };
    if (patch.goal !== undefined) updated.goal = patch.goal;
    if (patch.itemIds !== undefined) updated.itemIds = patch.itemIds;
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.startedAtUtc !== undefined) updated.startedAtUtc = patch.startedAtUtc;
    if (patch.endedAtUtc !== undefined) updated.endedAtUtc = patch.endedAtUtc;
    if (patch.verdict !== undefined) updated.verdict = patch.verdict;
    plan.sprints = plan.sprints.map((s, i) => (i === idx ? updated : s));
  }

  if (patch.status === "active") {
    plan.activeSprintId = id;
    const now = new Date().toISOString();
    plan.sprints = plan.sprints.map((s) =>
      s.status === "active" && s.id !== id ? { ...s, status: "done" as const, endedAtUtc: s.endedAtUtc ?? now } : s,
    );
  } else if (patch.status !== undefined && plan.activeSprintId === id) {
    delete plan.activeSprintId;
  }

  await writeSprintPlan(flowDir, runId, plan);
  return plan;
}
