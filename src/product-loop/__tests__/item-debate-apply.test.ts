/**
 * C4 — `item-debate-apply.ts`'s pure `applyItemDebateToPlanArtifact`.
 *
 * Mirrors `applyTaskVerdictsToPlanArtifact` (sprint-runner.ts ~1449) in
 * shape: a pure fold of a verdict list onto a `SprintPlanArtifact`. This
 * suite pins down each `changeKind`, the refusal cases (unknown dependency
 * id, a cycle), the split-rewrites-dependents behaviour, the "never touch a
 * done task" invariant, idempotency, and non-mutation — independent of any
 * wiring into a real per-item debate (that's a later slice).
 */

import { describe, expect, it } from "vitest";
import type { SprintItemDebateRecord } from "../../flow/run-artifacts.js";
import { applyItemDebateToPlanArtifact } from "../item-debate-apply.js";
import type { SprintItemDebateItemRecord } from "../item-debate-record.js";
import { buildTaskChecklistBlock, type SprintPlanArtifact, type SprintPlanTask } from "../sprint-plan-artifact.js";

function task(overrides: Partial<SprintPlanTask> & Pick<SprintPlanTask, "id" | "title">): SprintPlanTask {
  return {
    doneCriterion: "some criterion",
    dependsOn: [],
    targetFiles: ["src/Sample/Foo.cs"],
    targetDirs: [],
    status: "pending",
    ...overrides,
  };
}

function plan(tasks: SprintPlanTask[]): SprintPlanArtifact {
  return {
    version: 1,
    sprintN: 4,
    runId: "run-c4-test",
    planHash: "deadbeef",
    source: "structured",
    outcome: { goal: "Test goal", acceptance: [] },
    tasks,
    notes: ["pre-existing note"],
  };
}

function itemRecord(overrides: Partial<SprintItemDebateItemRecord> = {}): SprintItemDebateItemRecord {
  return {
    kind: "task",
    taskId: "step3",
    title: "Implement the rate limiter",
    selectionSignal: "vague-criterion",
    selectionReason: "no done criterion",
    positions: [],
    leaderRuling: "ruled",
    changeKind: "none",
    ...overrides,
  };
}

function record(items: SprintItemDebateItemRecord[]): SprintItemDebateRecord {
  return {
    version: 1,
    sprintN: 4,
    runId: "run-c4-test",
    enabled: true,
    items,
    stopReason: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:01:00.000Z",
  };
}

describe("applyItemDebateToPlanArtifact", () => {
  it('changeKind "none" changes nothing', () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const result = applyItemDebateToPlanArtifact(artifact, record([itemRecord({ changeKind: "none" })]));
    expect(result.artifact.tasks).toEqual(artifact.tasks);
    expect(result.changes).toEqual([{ itemId: "step3", changeKind: "none", ok: true, detail: "no change" }]);
  });

  it('changeKind "criterion" replaces the task\'s doneCriterion', () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter", doneCriterion: "vague" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([
        itemRecord({
          changeKind: "criterion",
          proposedChange: { criterionText: "dotnet test src/Sample.Tests passes with 0 failures" },
        }),
      ]),
    );
    expect(result.artifact.tasks[0]!.doneCriterion).toBe("dotnet test src/Sample.Tests passes with 0 failures");
    expect(result.changes[0]!.ok).toBe(true);
  });

  it('changeKind "dependency" adds a valid dependsOn id', () => {
    const artifact = plan([
      task({ id: "step1", title: "Create project" }),
      task({ id: "step3", title: "Implement the rate limiter" }),
    ]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ changeKind: "dependency", proposedChange: { dependsOnId: "step1" } })]),
    );
    const step3 = result.artifact.tasks.find((t) => t.id === "step3")!;
    expect(step3.dependsOn).toEqual(["step1"]);
    expect(result.changes[0]!.ok).toBe(true);
  });

  it('changeKind "dependency" refuses an unknown dependency id', () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ changeKind: "dependency", proposedChange: { dependsOnId: "step99" } })]),
    );
    expect(result.artifact.tasks[0]!.dependsOn).toEqual([]);
    expect(result.changes[0]!.ok).toBe(false);
    expect(result.changes[0]!.detail).toContain("unknown dependency id");
  });

  it('changeKind "dependency" refuses an edge that would create a cycle', () => {
    // step1 -> depends on step3 already; asking step3 to depend on step1
    // would close a 2-node cycle.
    const artifact = plan([task({ id: "step1", title: "A", dependsOn: ["step3"] }), task({ id: "step3", title: "B" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ taskId: "step3", changeKind: "dependency", proposedChange: { dependsOnId: "step1" } })]),
    );
    expect(result.artifact.tasks.find((t) => t.id === "step3")!.dependsOn).toEqual([]);
    expect(result.changes[0]!.ok).toBe(false);
    expect(result.changes[0]!.detail).toContain("cycle");
  });

  it('changeKind "split" replaces the task with deterministic ids and carries dependsOn', () => {
    const artifact = plan([
      task({ id: "step1", title: "Create project" }),
      task({ id: "step3", title: "Implement the rate limiter", dependsOn: ["step1"] }),
    ]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([
        itemRecord({
          changeKind: "split",
          proposedChange: { splitTitles: ["Implement the token bucket", "Wire it into the request pipeline"] },
        }),
      ]),
    );
    const ids = result.artifact.tasks.map((t) => t.id);
    expect(ids).toEqual(["step1", "step3a", "step3b"]);
    const parts = result.artifact.tasks.filter((t) => t.id === "step3a" || t.id === "step3b");
    for (const p of parts) expect(p.dependsOn).toEqual(["step1"]);
    expect(result.changes[0]!.ok).toBe(true);
  });

  it('changeKind "split" rewrites a dependent task to depend on every split part', () => {
    const artifact = plan([
      task({ id: "step3", title: "Implement the rate limiter" }),
      task({ id: "step4", title: "Write docs", dependsOn: ["step3"] }),
    ]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ changeKind: "split", proposedChange: { splitTitles: ["Part A", "Part B"] } })]),
    );
    const step4 = result.artifact.tasks.find((t) => t.id === "step4")!;
    expect(step4.dependsOn).toEqual(["step3a", "step3b"]);
  });

  it('changeKind "drop" marks the task dropped without deleting it', () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ changeKind: "drop", proposedChange: { note: "duplicate of step1" } })]),
    );
    expect(result.artifact.tasks).toHaveLength(1);
    const dropped = result.artifact.tasks[0]!;
    expect(dropped.status).toBe("dropped");
    expect(dropped.droppedReason).toBe("duplicate of step1");
    expect(result.changes[0]!.ok).toBe(true);
  });

  it("a dropped task is skipped by the checklist builder", () => {
    const artifact = plan([
      task({ id: "step1", title: "Create project" }),
      task({ id: "step3", title: "Implement the rate limiter" }),
    ]);
    const result = applyItemDebateToPlanArtifact(artifact, record([itemRecord({ changeKind: "drop" })]));
    const { block } = buildTaskChecklistBlock(result.artifact.tasks);
    expect(block).toContain("step1");
    expect(block).not.toContain("step3");
  });

  it("never touches a task whose status is done, for any changeKind", () => {
    const doneTask = task({ id: "step3", title: "Implement the rate limiter", status: "done", doneCriterion: "old" });
    const artifact = plan([doneTask]);
    const items: SprintItemDebateItemRecord[] = [
      itemRecord({ changeKind: "criterion", proposedChange: { criterionText: "new" } }),
    ];
    const result = applyItemDebateToPlanArtifact(artifact, record(items));
    expect(result.artifact.tasks[0]).toEqual(doneTask);
    expect(result.changes[0]!.ok).toBe(false);
    expect(result.changes[0]!.detail).toContain("is done");
  });

  it("applying the same record twice changes nothing the second time (criterion)", () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter", doneCriterion: "vague" })]);
    const r = record([itemRecord({ changeKind: "criterion", proposedChange: { criterionText: "tight criterion" } })]);
    const once = applyItemDebateToPlanArtifact(artifact, r);
    const twice = applyItemDebateToPlanArtifact(once.artifact, r);
    expect(twice.artifact.tasks).toEqual(once.artifact.tasks);
    expect(twice.changes[0]!.detail).toBe("already applied");
  });

  it("applying the same record twice changes nothing the second time (dependency)", () => {
    const artifact = plan([task({ id: "step1", title: "A" }), task({ id: "step3", title: "B" })]);
    const r = record([itemRecord({ changeKind: "dependency", proposedChange: { dependsOnId: "step1" } })]);
    const once = applyItemDebateToPlanArtifact(artifact, r);
    const twice = applyItemDebateToPlanArtifact(once.artifact, r);
    expect(twice.artifact.tasks).toEqual(once.artifact.tasks);
    expect(twice.changes[0]!.detail).toBe("already applied");
  });

  it("applying the same record twice changes nothing the second time (split)", () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const r = record([itemRecord({ changeKind: "split", proposedChange: { splitTitles: ["Part A", "Part B"] } })]);
    const once = applyItemDebateToPlanArtifact(artifact, r);
    const twice = applyItemDebateToPlanArtifact(once.artifact, r);
    expect(twice.artifact.tasks).toEqual(once.artifact.tasks);
    expect(twice.changes[0]!.detail).toBe("already applied");
  });

  it("applying the same record twice changes nothing the second time (drop)", () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const r = record([itemRecord({ changeKind: "drop" })]);
    const once = applyItemDebateToPlanArtifact(artifact, r);
    const twice = applyItemDebateToPlanArtifact(once.artifact, r);
    expect(twice.artifact.tasks).toEqual(once.artifact.tasks);
    expect(twice.changes[0]!.detail).toBe("already applied");
  });

  it("never mutates the input artifact or its task objects in place", () => {
    const originalTask = task({ id: "step3", title: "Implement the rate limiter", doneCriterion: "vague" });
    const artifact = plan([originalTask]);
    const snapshotTasks = artifact.tasks.map((t) => ({ ...t }));
    const snapshotNotes = [...artifact.notes];

    applyItemDebateToPlanArtifact(
      artifact,
      record([
        itemRecord({ changeKind: "criterion", proposedChange: { criterionText: "tight criterion" } }),
        itemRecord({ taskId: "step-missing", changeKind: "drop" }),
      ]),
    );

    expect(artifact.tasks).toEqual(snapshotTasks);
    expect(artifact.tasks[0]).toBe(originalTask);
    expect(artifact.notes).toEqual(snapshotNotes);
  });

  it("leaves planHash and outcome.goal untouched", () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([itemRecord({ changeKind: "drop", proposedChange: { note: "no longer needed" } })]),
    );
    expect(result.artifact.planHash).toBe(artifact.planHash);
    expect(result.artifact.outcome.goal).toBe(artifact.outcome.goal);
  });

  it("a criterion/dependency/drop item that only names a criterionId (no task) is refused, not silently skipped", () => {
    const artifact = plan([task({ id: "step3", title: "Implement the rate limiter" })]);
    const result = applyItemDebateToPlanArtifact(
      artifact,
      record([
        itemRecord({
          kind: "criterion",
          taskId: undefined,
          criterionId: "crit-abc",
          changeKind: "criterion",
          proposedChange: { criterionText: "x" },
        }),
      ]),
    );
    expect(result.artifact.tasks).toEqual(artifact.tasks);
    expect(result.changes[0]!.ok).toBe(false);
    expect(result.changes[0]!.itemId).toBe("crit-abc");
  });
});
