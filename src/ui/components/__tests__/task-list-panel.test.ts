import { describe, expect, it } from "vitest";
import type { TaskListItem, TaskListSnapshot } from "../../../types/index.js";
import { __TEST_ONLY__ } from "../task-list-panel.js";

const { sortItems, MAX_VISIBLE, buildCollapsedLine } = __TEST_ONLY__;

function item(id: string, status: TaskListItem["status"]): TaskListItem {
  return { id, subject: `Task ${id}`, status };
}

function snap(completed: number, inProgress: number, pending: number): TaskListSnapshot {
  return {
    items: [
      ...Array.from({ length: completed }, (_, i) => item(`c${i}`, "completed")),
      ...Array.from({ length: inProgress }, (_, i) => item(`p${i}`, "in_progress")),
      ...Array.from({ length: pending }, (_, i) => item(`q${i}`, "pending")),
    ],
    counts: { completed, inProgress, pending, total: completed + inProgress + pending },
    ts: 0,
  };
}

describe("TaskListPanel sortItems", () => {
  it("puts in_progress first, completed last, pending in middle", () => {
    const out = sortItems([
      item("a", "completed"),
      item("b", "pending"),
      item("c", "in_progress"),
      item("d", "completed"),
      item("e", "pending"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["c", "b", "e", "a", "d"]);
  });

  it("preserves order within the same status bucket (stable sort)", () => {
    const out = sortItems([item("1", "pending"), item("2", "pending"), item("3", "pending")]);
    expect(out.map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortItems([])).toEqual([]);
  });
});

describe("TaskListPanel MAX_VISIBLE", () => {
  it("caps inline list to 8 (guard against accidental bump)", () => {
    expect(MAX_VISIBLE).toBe(8);
  });
});

describe("TaskListPanel buildCollapsedLine", () => {
  it("summarizes counts on one line with an expand hint", () => {
    const line = buildCollapsedLine(snap(4, 1, 2));
    expect(line).toContain("Todos");
    expect(line).toContain("4 completed");
    expect(line).toContain("1 in progress");
    expect(line).toContain("2 queued");
    expect(line).toContain("ctrl+e");
    // Single line — the whole point is to reclaim vertical space.
    expect(line).not.toContain("\n");
  });

  it("omits zero buckets", () => {
    const line = buildCollapsedLine(snap(0, 0, 3));
    expect(line).toContain("3 queued");
    expect(line).not.toContain("completed");
    expect(line).not.toContain("in progress");
  });
});
