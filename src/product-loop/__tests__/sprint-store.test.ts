/**
 * src/product-loop/__tests__/sprint-store.test.ts
 *
 * Unit tests for sprint-store.ts (read/write/setActiveSprint/markSprintDone).
 * Uses a real temp directory — atomicWriteJSON is tested end-to-end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markSprintDone, readSprintPlan, setActiveSprint, upsertSprint, writeSprintPlan } from "../sprint-store.js";
import type { Sprint, SprintPlan } from "../types.js";

let tmpDir: string;

function makePlan(overrides?: Partial<SprintPlan>): SprintPlan {
  const sprints: Sprint[] = [
    { id: "sprint-1", number: 1, goal: "Goal 1", itemIds: ["a"], status: "planned" },
    { id: "sprint-2", number: 2, goal: "Goal 2", itemIds: ["b"], status: "planned" },
  ];
  return {
    runId: "test-run",
    sprints,
    createdAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "sprint-store-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("sprint-store", () => {
  it("returns null when sprint-plan.json does not exist", async () => {
    const result = await readSprintPlan(tmpDir, "no-run");
    expect(result).toBeNull();
  });

  it("write + read round-trip preserves all fields", async () => {
    const plan = makePlan();
    await writeSprintPlan(tmpDir, "test-run", plan);
    const read = await readSprintPlan(tmpDir, "test-run");
    expect(read).toEqual(plan);
  });

  it("setActiveSprint sets status=active and startedAtUtc", async () => {
    const plan = makePlan();
    await writeSprintPlan(tmpDir, "test-run", plan);

    const updated = await setActiveSprint(tmpDir, "test-run", "sprint-1");
    const s1 = updated.sprints.find((s) => s.id === "sprint-1")!;
    expect(s1.status).toBe("active");
    expect(s1.startedAtUtc).toBeTruthy();
    expect(updated.activeSprintId).toBe("sprint-1");
  });

  it("setActiveSprint flips previous active sprint to done", async () => {
    const plan = makePlan();
    plan.sprints[0].status = "active";
    plan.sprints[0].startedAtUtc = new Date().toISOString();
    plan.activeSprintId = "sprint-1";
    await writeSprintPlan(tmpDir, "test-run", plan);

    const updated = await setActiveSprint(tmpDir, "test-run", "sprint-2");
    const s1 = updated.sprints.find((s) => s.id === "sprint-1")!;
    const s2 = updated.sprints.find((s) => s.id === "sprint-2")!;
    expect(s1.status).toBe("done");
    expect(s1.endedAtUtc).toBeTruthy();
    expect(s2.status).toBe("active");
    expect(updated.activeSprintId).toBe("sprint-2");
  });

  it("markSprintDone sets endedAtUtc and clears activeSprintId", async () => {
    const plan = makePlan();
    plan.sprints[0].status = "active";
    plan.activeSprintId = "sprint-1";
    await writeSprintPlan(tmpDir, "test-run", plan);

    const updated = await markSprintDone(tmpDir, "test-run", "sprint-1");
    const s1 = updated.sprints.find((s) => s.id === "sprint-1")!;
    expect(s1.status).toBe("done");
    expect(s1.endedAtUtc).toBeTruthy();
    expect(updated.activeSprintId).toBeUndefined();
  });

  it("round-trip preserves string field types (no Date coercion)", async () => {
    const plan = makePlan();
    await writeSprintPlan(tmpDir, "test-run", plan);
    const read = await readSprintPlan(tmpDir, "test-run");
    expect(typeof read!.createdAtUtc).toBe("string");
    expect(typeof read!.sprints[0].goal).toBe("string");
  });

  describe("upsertSprint (S1)", () => {
    it("creates sprint-plan.json from scratch when none exists", async () => {
      const plan = await upsertSprint(tmpDir, "no-run", 1, { status: "active" });
      expect(plan.sprints).toHaveLength(1);
      expect(plan.sprints[0]).toMatchObject({ id: "sprint-1", number: 1, status: "active" });
      expect(plan.activeSprintId).toBe("sprint-1");
    });

    it("appends a sprint number the initial plan never predicted, with an honest placeholder goal", async () => {
      await writeSprintPlan(tmpDir, "test-run", makePlan()); // only sprint-1, sprint-2
      const plan = await upsertSprint(tmpDir, "test-run", 3, { status: "active" });
      expect(plan.sprints).toHaveLength(3);
      const s3 = plan.sprints.find((s) => s.number === 3)!;
      expect(s3.goal).toMatch(/not recorded/);
    });

    it("updates an existing entry in place instead of appending", async () => {
      await writeSprintPlan(tmpDir, "test-run", makePlan());
      const plan = await upsertSprint(tmpDir, "test-run", 1, {
        status: "done",
        endedAtUtc: "2026-01-01T00:00:00.000Z",
      });
      expect(plan.sprints).toHaveLength(2);
      const s1 = plan.sprints.find((s) => s.number === 1)!;
      expect(s1.status).toBe("done");
      expect(s1.goal).toBe("Goal 1"); // untouched field preserved
    });

    it("re-running the same sprint number never creates a duplicate", async () => {
      await upsertSprint(tmpDir, "test-run", 1, { status: "active" });
      await upsertSprint(tmpDir, "test-run", 1, { status: "done" });
      await upsertSprint(tmpDir, "test-run", 1, { status: "active" }); // retried
      const plan = await readSprintPlan(tmpDir, "test-run");
      expect(plan!.sprints.filter((s) => s.number === 1)).toHaveLength(1);
    });

    it("status=active flips a different sprint's active status to done", async () => {
      await upsertSprint(tmpDir, "test-run", 1, { status: "active" });
      const plan = await upsertSprint(tmpDir, "test-run", 2, { status: "active" });
      const s1 = plan.sprints.find((s) => s.number === 1)!;
      const s2 = plan.sprints.find((s) => s.number === 2)!;
      expect(s1.status).toBe("done");
      expect(s2.status).toBe("active");
      expect(plan.activeSprintId).toBe("sprint-2");
    });

    it("a terminal status clears activeSprintId when it pointed at this sprint", async () => {
      await upsertSprint(tmpDir, "test-run", 1, { status: "active" });
      const plan = await upsertSprint(tmpDir, "test-run", 1, { status: "done" });
      expect(plan.activeSprintId).toBeUndefined();
    });

    it("persists a verdict record", async () => {
      const plan = await upsertSprint(tmpDir, "test-run", 1, {
        status: "done",
        verdict: { pass: false, failedCondition: "engineering_floor", reason: "verify_FAIL" },
      });
      const s1 = plan.sprints.find((s) => s.number === 1)!;
      expect(s1.verdict).toEqual({ pass: false, failedCondition: "engineering_floor", reason: "verify_FAIL" });
    });
  });
});
