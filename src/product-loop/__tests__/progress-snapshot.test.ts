/**
 * src/product-loop/__tests__/progress-snapshot.test.ts
 *
 * Unit tests for computeProgressSnapshot() and renderSnapshotMarkdown().
 * Uses temp directories for backlog/sprint files. Mocks getDatabase so
 * no real SQLite DB is needed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBacklog } from "../backlog-store.js";
import { writeSprintPlan } from "../sprint-store.js";
import type { Backlog, BacklogItem, Sprint, SprintPlan } from "../types.js";

// ─── Mock DB ──────────────────────────────────────────────────────────────────

// Default: no sprint_stage rows
const mockDbGet = vi.fn().mockReturnValue(undefined);
const mockDbPrepare = vi.fn().mockReturnValue({ get: mockDbGet });
vi.mock("../../storage/db.js", () => ({
  getDatabase: vi.fn(() => ({ prepare: mockDbPrepare })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "progress-snapshot-test-"));
  mockDbGet.mockReturnValue(undefined); // reset to "no rows"
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeItem(overrides: Partial<BacklogItem> & { id: string }): BacklogItem {
  const now = new Date().toISOString();
  return {
    title: overrides.id,
    description: "",
    acceptance_criteria: ["crit-1", "crit-2"],
    entities: [],
    endpoints: [],
    mvp_priority: "v1",
    status: "backlog",
    effortPoints: 3,
    createdAtUtc: now,
    updatedAtUtc: now,
    ...overrides,
  };
}

function makeBacklog(items: BacklogItem[]): Backlog {
  return {
    runId: "run-1",
    productSlug: "test-product",
    items,
    derivedFromClarifyId: "abc",
    createdAtUtc: new Date().toISOString(),
  };
}

function makeSprint(overrides: Partial<Sprint> & { id: string; number: number }): Sprint {
  return {
    goal: `Goal for ${overrides.id}`,
    itemIds: [],
    status: "planned",
    ...overrides,
  };
}

function makeSprintPlan(sprints: Sprint[], activeSprintId?: string): SprintPlan {
  return {
    runId: "run-1",
    sprints,
    activeSprintId,
    createdAtUtc: new Date().toISOString(),
  };
}

describe("computeProgressSnapshot", () => {
  it("empty workspace returns all-zero snapshot without crashing", async () => {
    const { computeProgressSnapshot } = await import("../progress-snapshot.js");
    const snap = await computeProgressSnapshot({ flowDir: tmpDir, runId: "run-1", productSlug: "prod" });

    expect(snap.backlogTotal).toBe(0);
    expect(snap.backlogV1Count).toBe(0);
    expect(snap.sprintTotal).toBe(0);
    expect(snap.activeSprintNumber).toBeNull();
    expect(snap.activeSprintPercentDone).toBe(0);
    expect(snap.activeSprintItems).toHaveLength(0);
    expect(snap.blockers).toHaveLength(0);
    expect(snap.workerCurrentStage).toBeNull();
  });

  it("9 items / 3 sprints / 3 items done in active sprint → percentDone = 100", async () => {
    const { computeProgressSnapshot } = await import("../progress-snapshot.js");
    const items = [
      makeItem({ id: "i1", status: "done", assigned_sprint: "sprint-1" }),
      makeItem({ id: "i2", status: "done", assigned_sprint: "sprint-1" }),
      makeItem({ id: "i3", status: "done", assigned_sprint: "sprint-1" }),
      makeItem({ id: "i4", status: "backlog", assigned_sprint: "sprint-2" }),
      makeItem({ id: "i5", status: "backlog", assigned_sprint: "sprint-2" }),
      makeItem({ id: "i6", status: "backlog", assigned_sprint: "sprint-2" }),
      makeItem({ id: "i7", status: "backlog", assigned_sprint: "sprint-3" }),
      makeItem({ id: "i8", status: "backlog", assigned_sprint: "sprint-3" }),
      makeItem({ id: "i9", status: "backlog", assigned_sprint: "sprint-3" }),
    ];
    const backlog = makeBacklog(items);
    await writeBacklog(tmpDir, "run-1", backlog);

    const sprints = [
      makeSprint({ id: "sprint-1", number: 1, status: "active", itemIds: ["i1", "i2", "i3"] }),
      makeSprint({ id: "sprint-2", number: 2, status: "planned", itemIds: ["i4", "i5", "i6"] }),
      makeSprint({ id: "sprint-3", number: 3, status: "planned", itemIds: ["i7", "i8", "i9"] }),
    ];
    const plan = makeSprintPlan(sprints, "sprint-1");
    await writeSprintPlan(tmpDir, "run-1", plan);

    const snap = await computeProgressSnapshot({ flowDir: tmpDir, runId: "run-1", productSlug: "test-product" });

    expect(snap.sprintTotal).toBe(3);
    expect(snap.activeSprintNumber).toBe(1);
    expect(snap.activeSprintPercentDone).toBe(100);
    expect(snap.activeSprintItems).toHaveLength(3);
  });

  it("workerCurrentStage parsed from interaction_logs", async () => {
    mockDbGet.mockReturnValue({
      metadata_json: JSON.stringify({ sprintIndex: 2, stage: "planning" }),
      created_at: "2026-05-21T10:00:00.000Z",
    });

    const { computeProgressSnapshot } = await import("../progress-snapshot.js");
    const snap = await computeProgressSnapshot({ flowDir: tmpDir, runId: "run-1", productSlug: "prod" });

    expect(snap.workerCurrentStage).toBe("Sprint 2 — Planning");
    expect(snap.workerLastEventUtc).toBe("2026-05-21T10:00:00.000Z");
  });

  it("blockers detected for blocked items in active sprint", async () => {
    const { computeProgressSnapshot } = await import("../progress-snapshot.js");
    const items = [
      makeItem({ id: "b1", status: "blocked", assigned_sprint: "sprint-1", blockers: ["b2"] }),
      makeItem({ id: "b2", status: "backlog", assigned_sprint: "sprint-1" }),
    ];
    const backlog = makeBacklog(items);
    await writeBacklog(tmpDir, "run-1", backlog);

    const sprints = [makeSprint({ id: "sprint-1", number: 1, status: "active", itemIds: ["b1", "b2"] })];
    const plan = makeSprintPlan(sprints, "sprint-1");
    await writeSprintPlan(tmpDir, "run-1", plan);

    const snap = await computeProgressSnapshot({ flowDir: tmpDir, runId: "run-1", productSlug: "test-product" });

    expect(snap.blockers).toHaveLength(1);
    expect(snap.blockers[0].itemId).toBe("b1");
    expect(snap.blockers[0].reason).toContain("blocked by b2");
  });

  it("no active sprint → activeSprintNumber is null", async () => {
    const { computeProgressSnapshot } = await import("../progress-snapshot.js");
    const items = [makeItem({ id: "x", status: "in_sprint", assigned_sprint: "sprint-1" })];
    const backlog = makeBacklog(items);
    await writeBacklog(tmpDir, "run-1", backlog);

    const sprints = [makeSprint({ id: "sprint-1", number: 1, status: "planned", itemIds: ["x"] })];
    const plan = makeSprintPlan(sprints); // no activeSprintId
    await writeSprintPlan(tmpDir, "run-1", plan);

    const snap = await computeProgressSnapshot({ flowDir: tmpDir, runId: "run-1", productSlug: "test-product" });

    expect(snap.activeSprintNumber).toBeNull();
    expect(snap.activeSprintGoal).toBeNull();
    expect(snap.activeSprintItems).toHaveLength(0);
  });
});
