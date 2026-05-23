/**
 * src/tools/todo-write-snapshot.ts
 *
 * Parse the `todo_write` tool's arguments into a TaskListSnapshot the UI can
 * render. Pure / total — invalid input collapses to an empty snapshot instead
 * of throwing, so a malformed tool call never poisons the stream.
 *
 * The tool itself is registered in `src/tools/registry.ts`. This module is the
 * bridge between the raw argument JSON and the typed snapshot the orchestrator
 * yields as a `task_list_update` StreamChunk.
 */

import type { TaskListItem, TaskListItemStatus, TaskListSnapshot } from "../types/index.js";

const VALID_STATUSES: ReadonlyArray<TaskListItemStatus> = ["pending", "in_progress", "completed"];

function coerceStatus(raw: unknown): TaskListItemStatus {
  return typeof raw === "string" && (VALID_STATUSES as readonly string[]).includes(raw)
    ? (raw as TaskListItemStatus)
    : "pending";
}

function parseItem(raw: unknown, idx: number): TaskListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id ? obj.id : `t-${idx}`;
  const subject = typeof obj.subject === "string" && obj.subject.trim() ? obj.subject : null;
  if (!subject) return null;
  const activeForm = typeof obj.activeForm === "string" && obj.activeForm.trim() ? obj.activeForm.trim() : undefined;
  return { id, subject, status: coerceStatus(obj.status), ...(activeForm ? { activeForm } : {}) };
}

/**
 * Parse the JSON-encoded arguments string of a `todo_write` tool call.
 * Returns null when the input is unparseable or contains zero valid items,
 * so the orchestrator can skip emitting an empty chunk.
 */
export function snapshotFromTodoWriteArgs(argsJson: string): TaskListSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const todos = (parsed as { todos?: unknown[] }).todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const items: TaskListItem[] = [];
  todos.forEach((t, i) => {
    const item = parseItem(t, i);
    if (item) items.push(item);
  });
  if (items.length === 0) return null;

  const counts = { completed: 0, inProgress: 0, pending: 0, total: items.length };
  for (const it of items) {
    if (it.status === "completed") counts.completed++;
    else if (it.status === "in_progress") counts.inProgress++;
    else counts.pending++;
  }
  return { items, counts, ts: Date.now() };
}
