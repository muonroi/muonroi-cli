import { describe, expect, it } from "vitest";
import type { TaskListItem } from "../../../types/index.js";
import { __TEST_ONLY__ } from "../task-list-panel.js";

const { sortItems, MAX_VISIBLE } = __TEST_ONLY__;

function item(id: string, status: TaskListItem["status"]): TaskListItem {
  return { id, subject: `Task ${id}`, status };
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
