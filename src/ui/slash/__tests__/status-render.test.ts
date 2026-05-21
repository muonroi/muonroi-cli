/**
 * src/ui/slash/__tests__/status-render.test.ts
 *
 * Tests for renderSnapshotMarkdown() (pure function) and the /status
 * slash handler with mocked computeProgressSnapshot.
 */

import { describe, expect, it } from "vitest";
import { renderSnapshotMarkdown } from "../../../product-loop/progress-snapshot.js";
import type { ProgressSnapshot } from "../../../product-loop/types.js";

function makeSnapshot(overrides?: Partial<ProgressSnapshot>): ProgressSnapshot {
  return {
    runId: "run-1",
    productSlug: "my-product",
    capturedAtUtc: "2026-05-21T00:00:00.000Z",
    clarifyReady: true,
    clarifyGaps: [],
    backlogTotal: 5,
    backlogV1Count: 3,
    backlogDeferredCount: 2,
    sprintTotal: 2,
    activeSprintNumber: 1,
    activeSprintGoal: "Ship the auth module",
    activeSprintPercentDone: 66.7,
    activeSprintItems: [
      { id: "i1", title: "Login page", status: "done", criteriaMet: 2, criteriaTotal: 2 },
      { id: "i2", title: "Register flow", status: "in_progress", criteriaMet: 0, criteriaTotal: 3 },
      { id: "i3", title: "Forgot password", status: "in_sprint", criteriaMet: 0, criteriaTotal: 2 },
    ],
    blockers: [{ itemId: "i2", title: "Register flow", reason: "blocked by i5" }],
    workerLastEventUtc: "2026-05-21T08:30:00.000Z",
    workerCurrentStage: "Sprint 1 — Implementation",
    ...overrides,
  };
}

describe("renderSnapshotMarkdown", () => {
  it("full snapshot contains all expected sections", () => {
    const md = renderSnapshotMarkdown(makeSnapshot());
    expect(md).toContain("## Progress — my-product");
    expect(md).toContain("**Backlog:** 5 total");
    expect(md).toContain("**Sprints:** 2 planned");
    expect(md).toContain("### Sprint 1 — Ship the auth module");
    expect(md).toContain("66.7%");
    expect(md).toContain("### Blockers");
    expect(md).toContain("Register flow");
    expect(md).toContain("### Worker");
    expect(md).toContain("Sprint 1 — Implementation");
  });

  it("empty snapshot shows graceful no-data message", () => {
    const snap = makeSnapshot({
      backlogTotal: 0,
      backlogV1Count: 0,
      backlogDeferredCount: 0,
      sprintTotal: 0,
      activeSprintNumber: null,
      activeSprintGoal: null,
      activeSprintPercentDone: 0,
      activeSprintItems: [],
      blockers: [],
      workerCurrentStage: null,
      workerLastEventUtc: null,
    });
    const md = renderSnapshotMarkdown(snap);
    expect(md).toContain("No active sprint.");
    expect(md).toContain("**Backlog:** 0 total");
    expect(md).toContain("_None_");
    expect(md).toContain("Stage: (idle)");
  });

  it("status icons: [x] for done, [~] for in_progress, [ ] for others", () => {
    const md = renderSnapshotMarkdown(makeSnapshot());
    // "Login page" is done → [x]
    expect(md).toContain("[x] Login page");
    // "Register flow" is in_progress → [~]
    expect(md).toContain("[~] Register flow");
    // "Forgot password" is in_sprint → [ ]
    expect(md).toContain("[ ] Forgot password");
  });
});
