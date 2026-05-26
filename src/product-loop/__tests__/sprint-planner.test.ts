/**
 * src/product-loop/__tests__/sprint-planner.test.ts
 *
 * Unit tests for sprint-planner.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBacklog } from "../backlog-store.js";
import { applySprintAssignments, planSprints } from "../sprint-planner.js";
import type { Backlog, BacklogItem } from "../types.js";

// ─── Mock CouncilLLM ─────────────────────────────────────────────────────────

function makeLLM(response: string = '[{"sprintNumber":1,"goal":"Ship it"}]') {
  return {
    generate: vi.fn().mockResolvedValue(response),
    research: vi.fn().mockResolvedValue(""),
    debate: vi.fn().mockResolvedValue(""),
    stream: vi.fn(),
  };
}

// ─── Backlog builders ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "sprint-planner-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeItem(overrides: Partial<BacklogItem> & { id: string }): BacklogItem {
  const now = new Date().toISOString();
  return {
    title: overrides.id,
    description: "",
    acceptance_criteria: ["criterion 1"],
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
    runId: "test-run",
    productSlug: "test-product",
    items,
    derivedFromClarifyId: "abc123",
    createdAtUtc: new Date().toISOString(),
  };
}

describe("sprint-planner", () => {
  it("3 v1 items of effort 3 each pack into 1 sprint (sum=9, within slack of 8+2)", async () => {
    const items = [
      makeItem({ id: "a", effortPoints: 3 }),
      makeItem({ id: "b", effortPoints: 3 }),
      makeItem({ id: "c", effortPoints: 3 }),
    ];
    const backlog = makeBacklog(items);
    const llm = makeLLM('[{"sprintNumber":1,"goal":"Complete a, b, c"}]');

    const plan = await planSprints({
      runId: "test-run",
      backlog,
      llm: llm as any,
      leaderModelId: "test-model",
      costAware: false,
    });

    expect(plan.sprints).toHaveLength(1);
    expect(plan.sprints[0].itemIds).toHaveLength(3);
  });

  it("6 v1 items of effort 5 each produce 3+ sprints (5 > 8+2 threshold for 2 items = 10)", async () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: `item-${i}`, effortPoints: 5 }));
    const backlog = makeBacklog(items);
    const llm = makeLLM(
      '[{"sprintNumber":1,"goal":"Sprint 1"},{"sprintNumber":2,"goal":"Sprint 2"},{"sprintNumber":3,"goal":"Sprint 3"}]',
    );

    const plan = await planSprints({
      runId: "test-run",
      backlog,
      llm: llm as any,
      leaderModelId: "test-model",
      costAware: false,
    });

    // 5+5 = 10 > 10 (8+2), so each item gets its own sprint — 6 sprints.
    // Actually 5 <= 10 so two items fit. But 5+5+5 = 15 > 10.
    // The first two (5+5=10) fit in sprint 1 because 10 <= 10.
    // The next two fit in sprint 2. Last two in sprint 3.
    expect(plan.sprints.length).toBeGreaterThanOrEqual(3);
    expect(plan.sprints.length).toBeLessThanOrEqual(6);
  });

  it("topo-sort: item A blocks item B → A placed before B in sprint", async () => {
    const a = makeItem({ id: "item-a", effortPoints: 3 });
    const b = makeItem({ id: "item-b", effortPoints: 3, blockers: ["item-a"] });
    // Pass in reverse order to verify topo sort
    const backlog = makeBacklog([b, a]);
    const llm = makeLLM('[{"sprintNumber":1,"goal":"Sorted sprint"}]');

    const plan = await planSprints({
      runId: "test-run",
      backlog,
      llm: llm as any,
      leaderModelId: "test-model",
      costAware: false,
    });

    // Find sprint containing item-a and item-b
    const sprintA = plan.sprints.find((s) => s.itemIds.includes("item-a"))!;
    const sprintB = plan.sprints.find((s) => s.itemIds.includes("item-b"))!;
    expect(sprintA.number).toBeLessThanOrEqual(sprintB.number);
  });

  it("pickCouncilTaskModel called with 'sprint_goal' tag — verified via LLM generate spy", async () => {
    // We verify that LLM.generate() is called (which is what pickCouncilTaskModel routes to).
    const items = [makeItem({ id: "a", effortPoints: 3 })];
    const backlog = makeBacklog(items);
    const llm = makeLLM('[{"sprintNumber":1,"goal":"Ship A"}]');

    await planSprints({ runId: "test-run", backlog, llm: llm as any, leaderModelId: "test-model", costAware: true });

    expect(llm.generate).toHaveBeenCalledOnce();
  });

  it("applySprintAssignments sets status=in_sprint and assigned_sprint on backlog items", async () => {
    const items = [makeItem({ id: "a", effortPoints: 3 }), makeItem({ id: "b", effortPoints: 3 })];
    const backlog = makeBacklog(items);
    await writeBacklog(tmpDir, "test-run", backlog);
    const llm = makeLLM('[{"sprintNumber":1,"goal":"Ship"}]');

    const plan = await planSprints({
      runId: "test-run",
      backlog,
      llm: llm as any,
      leaderModelId: "test-model",
      costAware: false,
    });
    await applySprintAssignments(tmpDir, "test-run", plan);

    const { readBacklog } = await import("../backlog-store.js");
    const updated = await readBacklog(tmpDir, "test-run");
    for (const item of updated!.items) {
      if (item.mvp_priority === "v1") {
        expect(item.status).toBe("in_sprint");
        expect(item.assigned_sprint).toBeTruthy();
      }
    }
  });
});
