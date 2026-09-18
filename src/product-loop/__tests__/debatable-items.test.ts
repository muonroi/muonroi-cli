/**
 * C1 — `debatable-items.ts`'s pure selector.
 *
 * Debate today argues one blob (the whole sprint plan, sprint-runner.ts
 * ~1780's single `runCouncil` call). Per-item debate is only affordable if
 * something first decides which items are worth it — this suite pins that
 * selection logic down signal by signal, independent of any wiring into a
 * real sprint run (that's C5).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CouncilStanceRow } from "../../types/index.js";
import { criterionIdFromText } from "../criteria-seed.js";
import {
  DEFAULT_DEBATABLE_ITEMS_CAP,
  getDebatableItemsCap,
  isVagueCriterion,
  RISKY_TASK_TARGET_THRESHOLD,
  selectDebatableItems,
  VAGUE_CRITERION_MIN_CHARS,
} from "../debatable-items.js";
import type { ProjectRegistrationCheckResult } from "../project-registration-check.js";
import type { SprintPlanArtifact, SprintPlanTask } from "../sprint-plan-artifact.js";
import type { Criterion } from "../types.js";

// A verifiable, non-vague done criterion every "clean" fixture task uses by
// default, so a test only needs to override what it actually cares about.
const SPECIFIC_CRITERION = "dotnet test src/Sample.Tests passes with 0 failures";

function task(overrides: Partial<SprintPlanTask> & Pick<SprintPlanTask, "id" | "title">): SprintPlanTask {
  return {
    doneCriterion: SPECIFIC_CRITERION,
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
    sprintN: 1,
    runId: "run-c1-test",
    planHash: "deadbeef",
    source: tasks.length > 0 ? "structured" : "none",
    outcome: { goal: "Test goal", acceptance: [] },
    tasks,
    notes: [],
  };
}

function violatingStructureCheck(): ProjectRegistrationCheckResult {
  return {
    ecosystems: [
      {
        ecosystem: "C#",
        solutionFile: "src/Sample.sln",
        unregistered: [{ manifest: "src/New/New.csproj", reason: "not registered", solutionFile: "src/Sample.sln" }],
        status: "violations",
      },
    ],
    addedFilesSource: "git-diff+status",
    addedFilesCount: 1,
  };
}

describe("selectDebatableItems", () => {
  it("returns [] for a healthy sprint", () => {
    const healthy = [
      task({ id: "step1", title: "Create project", doneCriterion: "dotnet build succeeds with 0 errors" }),
      task({
        id: "step2",
        title: "Implement rule",
        dependsOn: ["step1"],
        status: "done",
        doneCriterion: "dotnet test passes",
      }),
      task({
        id: "step3",
        title: "Write docs",
        dependsOn: ["step2"],
        doneCriterion: "docs/README.md exists and describes the 3 rules",
      }),
    ];
    expect(selectDebatableItems({ plan: plan(healthy) })).toEqual([]);
  });

  it("selects only the deviated task when paired with a clean task", () => {
    const deviated = task({
      id: "step1",
      title: "Implement rule A",
      deviation: "Build fails: missing using directive",
    });
    const clean = task({ id: "step2", title: "Implement rule B" });
    const result = selectDebatableItems({ plan: plan([deviated, clean]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step1",
        title: "Implement rule A",
        signal: "task-deviation",
        reason: expect.stringContaining("missing using directive"),
      },
    ]);
  });

  it("selects a task with a vague done criterion but not one with a specific criterion", () => {
    const vague = task({ id: "step1", title: "Add validation A", doneCriterion: "Rule works correctly" });
    const specific = task({ id: "step2", title: "Add validation B", doneCriterion: SPECIFIC_CRITERION });
    const result = selectDebatableItems({ plan: plan([vague, specific]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step1",
        title: "Add validation A",
        signal: "vague-criterion",
        reason: expect.stringContaining("too short"),
      },
    ]);
  });

  it("selects a task naming no done criterion at all", () => {
    const empty = task({ id: "step1", title: "Add validation", doneCriterion: "" });
    const result = selectDebatableItems({ plan: plan([empty]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step1",
        title: "Add validation",
        signal: "vague-criterion",
        reason: expect.stringContaining("no done criterion"),
      },
    ]);
  });

  it("selects a task with an unknown dependency", () => {
    const t = task({ id: "step2", title: "Step two", dependsOn: ["stepX"] });
    const result = selectDebatableItems({ plan: plan([t]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step2",
        title: "Step two",
        signal: "unknown-dependency",
        reason: expect.stringContaining("stepX"),
      },
    ]);
  });

  it("does NOT select a merely-pending unmet dependency in a sprint where nothing progressed", () => {
    // Real-run defect: this is the NORMAL shape of an in-progress sprint —
    // arguing "step2 depends on step1 and step1 has not run" settles nothing.
    // Neither task carries any evidence (no deviation, no touchedTargets) and
    // nothing in the plan is done/dropped — nothing here is contested.
    const dep = task({ id: "step1", title: "Step one" });
    const dependent = task({ id: "step2", title: "Step two", dependsOn: ["step1"] });
    const result = selectDebatableItems({ plan: plan([dep, dependent]) });
    expect(result).toEqual([]);
  });

  it("selects an unmet dependency when the dependency itself has a reviewer deviation", () => {
    const dep = task({ id: "step1", title: "Step one", deviation: "half-implemented, build still fails" });
    const dependent = task({ id: "step2", title: "Step two", dependsOn: ["step1"] });
    const result = selectDebatableItems({ plan: plan([dep, dependent]), cap: 5 });
    // step1 ALSO independently fires task-deviation (score 100, unrelated to
    // this test) — assert step2's unmet-dependency item is present rather
    // than the whole array, so this test stays about ONE signal.
    expect(result).toContainEqual({
      kind: "task",
      id: "step2",
      title: "Step two",
      signal: "unmet-dependency",
      reason: expect.stringContaining("step1"),
    });
  });

  it("selects an unmet dependency when the dependency was reviewed and touchedTargets is false", () => {
    // Still "pending" (not claimed done), but the S3b reviewer already looked
    // and found the diff never touched its declared targets — concrete
    // negative evidence, not silence.
    const reviewedButUntouched = task({ id: "step1", title: "Step one", touchedTargets: false });
    const dependent = task({ id: "step2", title: "Step two", dependsOn: ["step1"] });
    const result = selectDebatableItems({ plan: plan([reviewedButUntouched, dependent]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step2",
        title: "Step two",
        signal: "unmet-dependency",
        reason: expect.stringContaining("step1"),
      },
    ]);
  });

  it("selects an unmet dependency when the sprint otherwise shows real progress", () => {
    // step1 is unrelated but DONE — the sprint moved. step3's block on the
    // still-pending, evidence-free step2 is now a meaningful signal.
    const moved = task({ id: "step1", title: "Unrelated finished task", status: "done" });
    const dep = task({ id: "step2", title: "Step two" });
    const dependent = task({ id: "step3", title: "Step three", dependsOn: ["step2"] });
    const result = selectDebatableItems({ plan: plan([moved, dep, dependent]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step3",
        title: "Step three",
        signal: "unmet-dependency",
        reason: expect.stringContaining("step2"),
      },
    ]);
  });

  it("selects a task naming more targets than the risky threshold", () => {
    const manyTargets = Array.from({ length: RISKY_TASK_TARGET_THRESHOLD + 1 }, (_, i) => `src/Sample/F${i}.cs`);
    const risky = task({ id: "step1", title: "Refactor everything", targetFiles: manyTargets });
    const result = selectDebatableItems({ plan: plan([risky]) });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step1",
        title: "Refactor everything",
        signal: "risky-task",
        reason: expect.stringContaining(String(RISKY_TASK_TARGET_THRESHOLD)),
      },
    ]);
  });

  it("keeps only the highest-scoring signal for one task firing several", () => {
    // Both an unknown dependency (score 80) and a vague criterion (score 40)
    // fire on this single task; only the unknown-dependency item should survive.
    const t = task({ id: "step1", title: "Messy task", dependsOn: ["stepX"], doneCriterion: "ok" });
    const result = selectDebatableItems({ plan: plan([t]) });
    expect(result).toHaveLength(1);
    expect(result[0]!.signal).toBe("unknown-dependency");
  });

  it("selects a criterion no panelist argued at all (findUndebatedCriteria)", () => {
    const criterionText = "Every project catches the warnings";
    const rows: CouncilStanceRow[] = [
      { criterion: criterionText, met: false, stances: { Architect: null, Skeptic: null } },
    ];
    const result = selectDebatableItems({ plan: plan([]), stanceRows: rows });
    expect(result).toEqual([
      {
        kind: "criterion",
        id: criterionIdFromText(criterionText),
        title: criterionText,
        signal: "undebated-criterion",
        reason: expect.stringContaining("No panelist"),
      },
    ]);
  });

  it("does NOT select an argued-but-unresolved criterion", () => {
    const rows: CouncilStanceRow[] = [
      { criterion: "Contested criterion", met: false, stances: { Architect: "+", Skeptic: "-" } },
    ];
    expect(selectDebatableItems({ plan: plan([]), stanceRows: rows })).toEqual([]);
  });

  it("selects a leader-deferred criterion", () => {
    const criterionText = "Ship the NuGet package";
    const rows: CouncilStanceRow[] = [
      { criterion: criterionText, met: false, stances: { Architect: "+", Skeptic: "-" }, deferred: true },
    ];
    const result = selectDebatableItems({ plan: plan([]), stanceRows: rows });
    expect(result).toEqual([
      {
        kind: "criterion",
        id: criterionIdFromText(criterionText),
        title: criterionText,
        signal: "leader-deferred-criterion",
        reason: expect.stringContaining("settleable only by building"),
      },
    ]);
  });

  it("does not select a stance-row criterion already marked met in criteria.json", () => {
    const criterionText = "Ship the NuGet package";
    const criteria: Criterion[] = [{ id: criterionIdFromText(criterionText), status: "met" }];
    const rows: CouncilStanceRow[] = [
      { criterion: criterionText, met: false, stances: { Architect: null, Skeptic: null } },
    ];
    expect(selectDebatableItems({ plan: plan([]), stanceRows: rows, criteria })).toEqual([]);
  });

  it("does not select a deviated task when a registration violation is already being fixed (S6)", () => {
    const deviated = task({
      id: "step1",
      title: "Implement rule A",
      deviation: "Build fails: missing using directive",
    });
    const result = selectDebatableItems({ plan: plan([deviated]), structureCheck: violatingStructureCheck() });
    expect(result).toEqual([]);
  });

  it("does not select a deviated task when the verify-fix loop is already handling it (S4)", () => {
    const deviated = task({ id: "step1", title: "Implement rule A", deviation: "Build fails: NRE at Foo.cs:10" });
    const result = selectDebatableItems({ plan: plan([deviated]), verifyFix: { triggered: true } });
    expect(result).toEqual([]);
  });

  it("still selects a non-deviation signal while the deterministic gates are active", () => {
    // The gate suppression only touches task-deviation — an unrelated vague
    // criterion on a different task must still surface.
    const deviated = task({
      id: "step1",
      title: "Implement rule A",
      deviation: "Build fails: missing using directive",
    });
    const vague = task({ id: "step2", title: "Add polish", doneCriterion: "Rule works correctly" });
    const result = selectDebatableItems({
      plan: plan([deviated, vague]),
      structureCheck: violatingStructureCheck(),
    });
    expect(result).toEqual([
      {
        kind: "task",
        id: "step2",
        title: "Add polish",
        signal: "vague-criterion",
        reason: expect.stringContaining("too short"),
      },
    ]);
  });

  it("caps the result at the default and orders deterministically for equal scores", () => {
    const tasks = ["step1", "step2", "step3", "step4"].map((id, i) =>
      task({ id, title: `Task ${i}`, doneCriterion: "x" }),
    );
    const result = selectDebatableItems({ plan: plan(tasks) });
    expect(result).toHaveLength(DEFAULT_DEBATABLE_ITEMS_CAP);
    expect(result.map((r) => r.id)).toEqual(["step1", "step2", "step3"]);
  });

  it("respects an explicit cap override", () => {
    const tasks = ["step1", "step2", "step3", "step4"].map((id, i) =>
      task({ id, title: `Task ${i}`, doneCriterion: "x" }),
    );
    const result = selectDebatableItems({ plan: plan(tasks), cap: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("step1");
  });
});

describe("isVagueCriterion", () => {
  it("flags empty text", () => {
    expect(isVagueCriterion("")).toBe(true);
    expect(isVagueCriterion("   ")).toBe(true);
  });

  it("flags a short criterion with nothing checkable", () => {
    expect(isVagueCriterion("Rule works correctly")).toBe(true);
  });

  it("never flags a criterion naming a file, a command, or a measurable outcome", () => {
    expect(isVagueCriterion(SPECIFIC_CRITERION)).toBe(false);
    expect(isVagueCriterion("npm test passes")).toBe(false);
    expect(isVagueCriterion("docs/README.md updated")).toBe(false);
    expect(isVagueCriterion("Coverage stays above 80%")).toBe(false);
  });

  it("treats VAGUE_CRITERION_MIN_CHARS as the length floor for unverifiable text", () => {
    const justBelow = "a".repeat(VAGUE_CRITERION_MIN_CHARS - 1);
    const atOrAbove = "a".repeat(VAGUE_CRITERION_MIN_CHARS);
    expect(isVagueCriterion(justBelow)).toBe(true);
    expect(isVagueCriterion(atOrAbove)).toBe(false);
  });
});

describe("getDebatableItemsCap", () => {
  const ORIGINAL = process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP;
    else process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP = ORIGINAL;
  });

  it("returns the default when unset", () => {
    delete process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP;
    expect(getDebatableItemsCap()).toBe(DEFAULT_DEBATABLE_ITEMS_CAP);
  });

  it("honours a valid override", () => {
    process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP = "5";
    expect(getDebatableItemsCap()).toBe(5);
  });

  it("ignores an invalid (non-numeric) override and logs why", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP = "not-a-number";
    expect(getDebatableItemsCap()).toBe(DEFAULT_DEBATABLE_ITEMS_CAP);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores a zero/negative override", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP = "0";
    expect(getDebatableItemsCap()).toBe(DEFAULT_DEBATABLE_ITEMS_CAP);
    process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP = "-1";
    expect(getDebatableItemsCap()).toBe(DEFAULT_DEBATABLE_ITEMS_CAP);
    spy.mockRestore();
  });
});
