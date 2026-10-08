/**
 * S3b — `topologicallyOrderTasks` + `buildTaskChecklistBlock`
 * (`sprint-plan-artifact.ts`): the pure ordering/rendering logic behind the
 * implementation prompt's task checklist. `sprint-runner.ts`'s wiring
 * (appending the block to `implPrompt`) is covered separately in
 * `sprint-plan-artifact-integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  boundTaskText,
  buildTaskChecklistBlock,
  MAX_TASK_TEXT_CHARS,
  type SprintPlanTask,
  topologicallyOrderTasks,
} from "../sprint-plan-artifact.js";

function task(partial: Partial<SprintPlanTask> & { id: string; title: string }): SprintPlanTask {
  return {
    doneCriterion: "",
    dependsOn: [],
    targetFiles: [],
    targetDirs: [],
    status: "pending",
    ...partial,
  };
}

describe("topologicallyOrderTasks", () => {
  it("orders a linear dependency chain", () => {
    const tasks = [
      task({ id: "step3", title: "third", dependsOn: ["step2"] }),
      task({ id: "step1", title: "first", dependsOn: [] }),
      task({ id: "step2", title: "second", dependsOn: ["step1"] }),
    ];
    const { order, notes } = topologicallyOrderTasks(tasks);
    expect(order.map((t) => t.id)).toEqual(["step1", "step2", "step3"]);
    expect(notes).toEqual([]);
  });

  it("breaks ties by the tasks' original array order (deterministic)", () => {
    const tasks = [task({ id: "stepB", title: "B", dependsOn: [] }), task({ id: "stepA", title: "A", dependsOn: [] })];
    const { order } = topologicallyOrderTasks(tasks);
    // Both are zero-indegree; original order (B before A) is preserved.
    expect(order.map((t) => t.id)).toEqual(["stepB", "stepA"]);
  });

  it("ignores an unknown dependsOn reference for ordering, and notes it", () => {
    const tasks = [task({ id: "step1", title: "only task", dependsOn: ["step99"] })];
    const { order, notes } = topologicallyOrderTasks(tasks);
    expect(order.map((t) => t.id)).toEqual(["step1"]);
    expect(notes.some((n) => n.includes("step1") && n.includes("step99"))).toBe(true);
  });

  it("handles a dependency cycle deterministically: cycle members kept in original order, with one note", () => {
    const tasks = [
      task({ id: "step1", title: "first", dependsOn: ["step2"] }),
      task({ id: "step2", title: "second", dependsOn: ["step1"] }),
      task({ id: "step3", title: "third (no dep)", dependsOn: [] }),
    ];
    const { order, notes } = topologicallyOrderTasks(tasks);
    // step3 has no dependency and is ready immediately; step1/step2 are stuck
    // in the cycle and are appended afterwards, in their original order.
    expect(order.map((t) => t.id)).toEqual(["step3", "step1", "step2"]);
    expect(notes.some((n) => n.includes("cycle") && n.includes("step1") && n.includes("step2"))).toBe(true);
  });

  it("is deterministic across repeated calls on the same input", () => {
    const tasks = [
      task({ id: "step2", title: "second", dependsOn: ["step1"] }),
      task({ id: "step1", title: "first", dependsOn: [] }),
    ];
    const a = topologicallyOrderTasks(tasks);
    const b = topologicallyOrderTasks(tasks);
    expect(a.order.map((t) => t.id)).toEqual(b.order.map((t) => t.id));
  });

  // Regression (acceptance review, small fix #4): a Map keyed by task id
  // previously collapsed duplicate ids onto one entry — the SECOND occurrence
  // matched `visited.has(id)` on the FIRST's processing and was silently
  // dropped from `order` (and never reached the cycle fallback either, since
  // its id was already marked visited). Every occurrence must survive.
  it("a duplicate task id: BOTH occurrences are kept (never silently dropped), with a note", () => {
    const tasks = [
      task({ id: "step1", title: "first copy", dependsOn: [] }),
      task({ id: "step1", title: "second copy (duplicate id)", dependsOn: [] }),
      task({ id: "step2", title: "depends on step1", dependsOn: ["step1"] }),
    ];
    const { order, notes } = topologicallyOrderTasks(tasks);

    expect(order).toHaveLength(3);
    expect(order.map((t) => t.title)).toEqual(
      expect.arrayContaining(["first copy", "second copy (duplicate id)", "depends on step1"]),
    );
    // step2 (dependent on the duplicated "step1") must still be ordered AFTER
    // both step1 occurrences.
    const idxStep2 = order.findIndex((t) => t.title === "depends on step1");
    const idxCopy1 = order.findIndex((t) => t.title === "first copy");
    const idxCopy2 = order.findIndex((t) => t.title === "second copy (duplicate id)");
    expect(idxStep2).toBeGreaterThan(idxCopy1);
    expect(idxStep2).toBeGreaterThan(idxCopy2);

    expect(notes.some((n) => n.includes('"step1"') && n.includes("2 times"))).toBe(true);
  });

  it("a duplicate id with NO dependents still keeps both occurrences", () => {
    const tasks = [task({ id: "step1", title: "copy A" }), task({ id: "step1", title: "copy B" })];
    const { order } = topologicallyOrderTasks(tasks);
    expect(order).toHaveLength(2);
    expect(order.map((t) => t.title).sort()).toEqual(["copy A", "copy B"]);
  });
});

describe("boundTaskText", () => {
  it("leaves short text untouched", () => {
    expect(boundTaskText("short title")).toBe("short title");
  });

  it("truncates text over the cap with an ellipsis marker", () => {
    const long = "x".repeat(MAX_TASK_TEXT_CHARS + 50);
    const bounded = boundTaskText(long);
    expect(bounded.length).toBeLessThanOrEqual(MAX_TASK_TEXT_CHARS + 1); // +1 for the "…" marker
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toBe(long);
  });
});

describe("buildTaskChecklistBlock", () => {
  it("empty tasks -> empty block, empty notes", () => {
    const { block, notes } = buildTaskChecklistBlock([]);
    expect(block).toBe("");
    expect(notes).toEqual([]);
  });

  it("renders id, title, done-criterion and targets, in topological order", () => {
    const tasks = [
      task({
        id: "step2",
        title: "implement the endpoint",
        doneCriterion: "returns 200",
        dependsOn: ["step1"],
        targetFiles: ["src/api/endpoint.ts"],
      }),
      task({
        id: "step1",
        title: "scaffold the project",
        doneCriterion: "builds",
        targetDirs: ["src/api"],
      }),
    ];
    const { block, notes } = buildTaskChecklistBlock(tasks);
    expect(notes).toEqual([]);
    expect(block).toContain("SPRINT TASK CHECKLIST");
    expect(block).toContain("work through these IN ORDER");
    expect(block).toContain("do not skip");

    // Topological order: step1 (no deps) before step2 (depends on step1).
    const idxStep1 = block.indexOf("[step1]");
    const idxStep2 = block.indexOf("[step2]");
    expect(idxStep1).toBeGreaterThanOrEqual(0);
    expect(idxStep2).toBeGreaterThan(idxStep1);

    expect(block).toContain("scaffold the project");
    expect(block).toContain("builds");
    expect(block).toContain("src/api");
    expect(block).toContain("implement the endpoint");
    expect(block).toContain("returns 200");
    expect(block).toContain("src/api/endpoint.ts");
  });

  it("a task with no done-criterion and no targets still renders (id + title only)", () => {
    const tasks = [task({ id: "step1", title: "manually verify in the IDE" })];
    const { block } = buildTaskChecklistBlock(tasks);
    expect(block).toContain("[step1] manually verify in the IDE");
    expect(block).not.toContain("done when:");
    expect(block).not.toContain("targets:");
  });

  it("surfaces the cycle/unknown-dependency notes from topologicallyOrderTasks", () => {
    const tasks = [task({ id: "step1", title: "only task", dependsOn: ["step-unknown"] })];
    const { notes } = buildTaskChecklistBlock(tasks);
    expect(notes.some((n) => n.includes("step-unknown"))).toBe(true);
  });

  it("bounds a runaway title/doneCriterion so one task cannot blow the prompt budget", () => {
    const longTitle = "T".repeat(MAX_TASK_TEXT_CHARS + 80);
    const longDone = "D".repeat(MAX_TASK_TEXT_CHARS + 80);
    const tasks = [task({ id: "step1", title: longTitle, doneCriterion: longDone })];
    const { block } = buildTaskChecklistBlock(tasks);

    expect(block).not.toContain(longTitle);
    expect(block).not.toContain(longDone);
    expect(block).toContain(boundTaskText(longTitle));
    expect(block).toContain(boundTaskText(longDone));
  });
});
