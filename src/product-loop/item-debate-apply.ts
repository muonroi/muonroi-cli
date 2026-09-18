/**
 * src/product-loop/item-debate-apply.ts
 *
 * C4 — fold a C3 `SprintItemDebateRecord`'s per-item rulings
 * (`item-debate-record.ts`, `flow/run-artifacts.ts`) into a
 * `SprintPlanArtifact`: `applyItemDebateToPlanArtifact` is the item-debate
 * analogue of `applyTaskVerdictsToPlanArtifact` (sprint-runner.ts ~1449) —
 * same shape (pure fold over a verdict list, never throws, `planHash`
 * untouched, a caller supplies both inputs from what it already has).
 *
 * Pure, deterministic, no I/O. Never mutates its `artifact` argument or any
 * of its `tasks` entries in place — every changed task is a NEW object, so
 * the input artifact (and every artifact returned by an earlier call) stays
 * exactly as it was.
 *
 * `planHash` (sha256 of the plan's `planSynthesis` text) is left untouched
 * by every changeKind here, for the same reason `applyTaskVerdictsToPlanArtifact`
 * leaves it untouched: it is the plan-TEXT staleness key, and an item-debate
 * ruling edits sprint-runner-owned task STRUCTURE after the fact — the same
 * category of change task-status updates already are, and those don't touch
 * it either.
 *
 * @testonly — no production consumer yet; wired into a real per-item debate
 * by a later slice (see `debatable-items.ts` module doc for the same pattern).
 */

import type { SprintItemDebateRecord } from "../flow/run-artifacts.js";
import type { ItemDebateChangeKind, SprintItemDebateItemRecord } from "./item-debate-record.js";
import {
  boundTaskText,
  MAX_TASK_TEXT_CHARS,
  type SprintPlanArtifact,
  type SprintPlanTask,
} from "./sprint-plan-artifact.js";

/** One item's outcome after `applyItemDebateToPlanArtifact` tried to apply
 * it — the shape a caller uses to fill `SprintItemDebateItemRecord.applied`
 * back in before re-persisting the record (a later slice's job, not this
 * module's — see module doc). */
export interface ItemDebateApplyChange {
  /** The task or criterion id this item targeted (`item.taskId ?? item.criterionId`). */
  itemId: string;
  changeKind: ItemDebateChangeKind;
  ok: boolean;
  /** Bounded, human-readable outcome — e.g. "added dependsOn step1" or
   * "refused: unknown dependency id step9". */
  detail: string;
}

export interface ApplyItemDebateResult {
  artifact: SprintPlanArtifact;
  changes: ItemDebateApplyChange[];
}

function bound(text: string): string {
  return boundTaskText(text, MAX_TASK_TEXT_CHARS);
}

function findTaskIndex(tasks: readonly SprintPlanTask[], id: string): number {
  return tasks.findIndex((t) => t.id === id);
}

function taskExists(tasks: readonly SprintPlanTask[], id: string): boolean {
  return tasks.some((t) => t.id === id);
}

/** True when adding the edge `fromId -> toId` (fromId depends on toId) would
 * create a dependency cycle — i.e. `toId` can already (transitively) reach
 * `fromId` via the CURRENT `dependsOn` edges. */
function wouldCreateCycle(tasks: readonly SprintPlanTask[], fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const seen = new Set<string>();
  const stack: string[] = [toId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of byId.get(cur)?.dependsOn ?? []) stack.push(dep);
  }
  return false;
}

/** Deterministic split-id suffix: `a`, `b`, ... `z`, then a numeric fallback
 * (a sprint task rarely splits into more than a handful of pieces, but this
 * never produces a collision by running out of letters). */
function splitSuffix(i: number): string {
  return i < 26 ? String.fromCharCode(97 + i) : String(i);
}

function deriveSplitIds(originalId: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${originalId}${splitSuffix(i)}`);
}

function replaceAt(tasks: readonly SprintPlanTask[], idx: number, replacement: SprintPlanTask[]): SprintPlanTask[] {
  return [...tasks.slice(0, idx), ...replacement, ...tasks.slice(idx + 1)];
}

/** Any OTHER task's `dependsOn` naming `originalId` now depends on EVERY
 * split part instead (it needed the whole original scope done; splitting it
 * doesn't reduce what the dependent still needs). Dedup — a dependent that
 * already names one split id is not given a duplicate entry. */
function rewriteDependents(tasks: readonly SprintPlanTask[], originalId: string, splitIds: string[]): SprintPlanTask[] {
  return tasks.map((t) => {
    if (!t.dependsOn.includes(originalId)) return t;
    const rewritten = t.dependsOn.flatMap((d) => (d === originalId ? splitIds : [d]));
    return { ...t, dependsOn: Array.from(new Set(rewritten)) };
  });
}

interface ApplyOutcome {
  tasks: SprintPlanTask[];
  change: ItemDebateApplyChange;
}

function applyCriterion(
  tasks: readonly SprintPlanTask[],
  item: SprintItemDebateItemRecord,
  itemId: string,
): ApplyOutcome {
  const base = { itemId, changeKind: "criterion" as const };
  const idx = findTaskIndex(tasks, item.taskId!);
  if (idx === -1)
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `refused: unknown task id "${item.taskId}"` } };
  const task = tasks[idx]!;
  if (task.status === "done") {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `skipped: task ${task.id} is done` } };
  }
  const criterionText = item.proposedChange?.criterionText?.trim();
  if (!criterionText) {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: "refused: no criterion text supplied" } };
  }
  const newText = bound(criterionText);
  if (task.doneCriterion === newText) {
    return { tasks: [...tasks], change: { ...base, ok: true, detail: "already applied" } };
  }
  return {
    tasks: replaceAt(tasks, idx, [{ ...task, doneCriterion: newText }]),
    change: { ...base, ok: true, detail: `replaced doneCriterion for ${task.id}` },
  };
}

function applyDependency(
  tasks: readonly SprintPlanTask[],
  item: SprintItemDebateItemRecord,
  itemId: string,
): ApplyOutcome {
  const base = { itemId, changeKind: "dependency" as const };
  const idx = findTaskIndex(tasks, item.taskId!);
  if (idx === -1)
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `refused: unknown task id "${item.taskId}"` } };
  const task = tasks[idx]!;
  if (task.status === "done") {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `skipped: task ${task.id} is done` } };
  }
  const depId = item.proposedChange?.dependsOnId?.trim();
  if (!depId) {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: "refused: no dependency id supplied" } };
  }
  if (depId === task.id) {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: "refused: a task cannot depend on itself" } };
  }
  if (!taskExists(tasks, depId)) {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `refused: unknown dependency id "${depId}"` } };
  }
  if (task.dependsOn.includes(depId)) {
    return { tasks: [...tasks], change: { ...base, ok: true, detail: "already applied" } };
  }
  if (wouldCreateCycle(tasks, task.id, depId)) {
    return {
      tasks: [...tasks],
      change: { ...base, ok: false, detail: `refused: adding dependsOn "${depId}" would create a cycle` },
    };
  }
  return {
    tasks: replaceAt(tasks, idx, [{ ...task, dependsOn: [...task.dependsOn, depId] }]),
    change: { ...base, ok: true, detail: `added dependsOn "${depId}" to ${task.id}` },
  };
}

function applySplit(tasks: readonly SprintPlanTask[], item: SprintItemDebateItemRecord, itemId: string): ApplyOutcome {
  const base = { itemId, changeKind: "split" as const };
  const originalId = item.taskId!;
  const titles = (item.proposedChange?.splitTitles ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const idx = findTaskIndex(tasks, originalId);

  if (idx === -1) {
    // Not present — either a genuinely unknown id, or this exact split was
    // already applied by an earlier call (the original task no longer
    // exists once replaced). Tell the two apart via the deterministic ids.
    if (titles.length >= 2) {
      const ids = deriveSplitIds(originalId, titles.length);
      if (ids.every((id) => taskExists(tasks, id))) {
        return { tasks: [...tasks], change: { ...base, ok: true, detail: "already applied" } };
      }
    }
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `refused: unknown task id "${originalId}"` } };
  }

  const task = tasks[idx]!;
  if (task.status === "done") {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `skipped: task ${task.id} is done` } };
  }
  if (titles.length < 2) {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: "refused: split requires at least 2 titles" } };
  }

  const ids = deriveSplitIds(originalId, titles.length);
  const collision = ids.find((id) => id !== originalId && taskExists(tasks, id));
  if (collision) {
    return {
      tasks: [...tasks],
      change: { ...base, ok: false, detail: `refused: split id "${collision}" already exists` },
    };
  }

  // Each part carries the original task's OWN dependsOn (both parts still
  // need what the whole task needed) and — since the split text alone
  // cannot say which target belongs to which part — the original's full
  // target list, so neither part silently loses a declared target.
  const parts: SprintPlanTask[] = titles.map((title, i) => ({
    id: ids[i]!,
    title: bound(title),
    doneCriterion: "",
    dependsOn: [...task.dependsOn],
    targetFiles: [...task.targetFiles],
    targetDirs: [...task.targetDirs],
    status: "pending",
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    ...(task.estimate !== undefined ? { estimate: task.estimate } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
  }));

  const replaced = replaceAt(tasks, idx, parts);
  const rewritten = rewriteDependents(replaced, originalId, ids);
  return { tasks: rewritten, change: { ...base, ok: true, detail: `split ${originalId} into ${ids.join(", ")}` } };
}

function applyDrop(tasks: readonly SprintPlanTask[], item: SprintItemDebateItemRecord, itemId: string): ApplyOutcome {
  const base = { itemId, changeKind: "drop" as const };
  const idx = findTaskIndex(tasks, item.taskId!);
  if (idx === -1)
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `refused: unknown task id "${item.taskId}"` } };
  const task = tasks[idx]!;
  if (task.status === "done") {
    return { tasks: [...tasks], change: { ...base, ok: false, detail: `skipped: task ${task.id} is done` } };
  }
  if (task.status === "dropped") {
    return { tasks: [...tasks], change: { ...base, ok: true, detail: "already applied" } };
  }
  const reason = bound(item.proposedChange?.note?.trim() || item.leaderRuling || "dropped by item-debate ruling");
  return {
    tasks: replaceAt(tasks, idx, [{ ...task, status: "dropped", droppedReason: reason }]),
    change: { ...base, ok: true, detail: `dropped ${task.id}: ${reason}` },
  };
}

/** Apply one item's ruling to the CURRENT working `tasks` array. Every
 * branch returns a change entry — never throws, never silently no-ops
 * without saying so. */
function applyOneItem(tasks: readonly SprintPlanTask[], item: SprintItemDebateItemRecord): ApplyOutcome {
  const itemId = item.taskId ?? item.criterionId ?? "(unknown)";

  if (item.changeKind === "none") {
    return { tasks: [...tasks], change: { itemId, changeKind: "none", ok: true, detail: "no change" } };
  }

  if (!item.taskId) {
    // A criterion-only item (no task id) names nothing in this artifact to
    // edit — criteria.json is a separate concern this artifact never owns.
    return {
      tasks: [...tasks],
      change: {
        itemId,
        changeKind: item.changeKind,
        ok: false,
        detail: "refused: item has no matching task id (it traces to a criterion, not a task)",
      },
    };
  }

  switch (item.changeKind) {
    case "criterion":
      return applyCriterion(tasks, item, itemId);
    case "dependency":
      return applyDependency(tasks, item, itemId);
    case "split":
      return applySplit(tasks, item, itemId);
    case "drop":
      return applyDrop(tasks, item, itemId);
  }
}

/**
 * Fold every item in `record.items` into `artifact`, in order, returning a
 * NEW artifact (the input is never mutated) plus one `ItemDebateApplyChange`
 * per item describing what happened. Idempotent: applying the SAME record to
 * the artifact this function already produced changes nothing further (every
 * branch above checks "is this already the case?" before writing).
 *
 * A task whose `status` is `"done"` is never touched by any changeKind.
 * `artifact.outcome.goal` and `artifact.planHash` are never touched either
 * (see module doc for `planHash`).
 *
 * @testonly — no production consumer yet; see module doc.
 */
export function applyItemDebateToPlanArtifact(
  artifact: SprintPlanArtifact,
  record: SprintItemDebateRecord,
): ApplyItemDebateResult {
  let tasks: SprintPlanTask[] = artifact.tasks.map((t) => ({ ...t }));
  const changes: ItemDebateApplyChange[] = [];
  for (const item of record.items) {
    const outcome = applyOneItem(tasks, item);
    tasks = outcome.tasks;
    changes.push(outcome.change);
  }
  return { artifact: { ...artifact, tasks }, changes };
}
