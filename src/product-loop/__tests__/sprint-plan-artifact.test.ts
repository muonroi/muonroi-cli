/**
 * S3a — `sprint-plan-artifact.ts`'s pure builder.
 *
 * `sprint-plan-structured.md` is a SYNTHETIC fixture (neutral "Acme.Widgets"
 * naming) shaped like a real `sprints/<n>-plan.md` produced by the full
 * `runPlanning` council path — same JSON-block-then-`---READABLE---` layout,
 * same `actionItems[]` object fields (`step`, `owner_lens`, `time_estimate`,
 * `depends_on`, `acceptance_criteria`) as the live evidence (run mu54vrme4c87).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSprintPlanArtifact } from "../sprint-plan-artifact.js";

const FIXTURES_DIR = join(__dirname, "fixtures");
const STRUCTURED_FIXTURE = readFileSync(join(FIXTURES_DIR, "sprint-plan-structured.md"), "utf8");

describe("buildSprintPlanArtifact", () => {
  describe("full-path plan text (JSON block heads the text)", () => {
    it("recovers a structured plan with 10 wired tasks from the real-shaped fixture", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-s3a-1",
        planSynthesis: STRUCTURED_FIXTURE,
      });

      expect(artifact.source).toBe("structured");
      expect(artifact.tasks).toHaveLength(10);
      expect(artifact.tasks.map((t) => t.id)).toEqual([
        "step1",
        "step2",
        "step3",
        "step4",
        "step5",
        "step6",
        "step7",
        "step8",
        "step9",
        "step10",
      ]);
      expect(artifact.tasks.every((t) => t.status === "pending")).toBe(true);

      // dependsOn wired: step2/3/4 depend on step1, step5 depends on step2/3/4.
      expect(artifact.tasks[0]!.dependsOn).toEqual([]);
      expect(artifact.tasks[1]!.dependsOn).toEqual(["step1"]);
      expect(artifact.tasks[2]!.dependsOn).toEqual(["step1"]);
      expect(artifact.tasks[3]!.dependsOn).toEqual(["step1"]);
      expect(artifact.tasks[4]!.dependsOn).toEqual(["step2", "step3", "step4"]);

      // Goal: the plan's own `summary` field, verbatim.
      expect(artifact.outcome.goal).toContain("Sprint 1 plan: build the Acme.Widgets Roslyn analyzer");

      // Acceptance: non-empty, sourced from the plan's own acceptance_criteria.
      expect(artifact.outcome.acceptance.length).toBeGreaterThan(0);
      expect(artifact.outcome.acceptance[0]).toContain("ACME0001");

      // step1 names both a FILE (the .sln registration, dotted extension) and a
      // DIRECTORY (the bare "src/Acme.Widgets" — no extension, so targetFiles'
      // regex never matches it; targetDirs recovers it).
      expect(artifact.tasks[0]!.targetFiles).toContain("src/Acme.sln");
      expect(artifact.tasks[0]!.targetDirs).toContain("src/Acme.Widgets");
      expect(artifact.tasks[0]!.title).toContain("src/Acme.Widgets");

      expect(artifact.tasks[0]!.owner).toBe("Roslyn Analyzer Engineer");
      expect(artifact.tasks[0]!.estimate).toBe("2h");
      expect(artifact.tasks[0]!.doneCriterion.length).toBeGreaterThan(0);

      // planHash: a deterministic sha256 of the exact planSynthesis this
      // artifact was built from (the staleness key persisted alongside it).
      expect(artifact.planHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reports high per-task target coverage (targetFiles ∪ targetDirs) on the real-shaped fixture", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-s3a-1",
        planSynthesis: STRUCTURED_FIXTURE,
      });

      const covered = artifact.tasks.filter((t) => t.targetFiles.length > 0 || t.targetDirs.length > 0);
      // 8/10: steps 1-8 (setup, the 3 rule implementations, disable-support
      // config, the test project + its tests, NuGet packaging) all name a real
      // src/-rooted file or directory. Steps 9-10 (manual VS verification,
      // docs/ — "docs" is not a known prefix) honestly name none, matching the
      // live evidence's own gap for its equivalent steps.
      // Coverage is 8/10 — reported here as the expectation itself, not via a
      // log line, so the number is pinned rather than merely printed.
      expect(covered.length).toBe(8);
      expect(covered.length / artifact.tasks.length).toBeGreaterThanOrEqual(0.7);
    });

    it("a bare directory (no extension) contributes to targetDirs, excluding anything already a file", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-s3a-1",
        planSynthesis: STRUCTURED_FIXTURE,
      });

      // step5: "Add per-rule disable support in src/Acme.Widgets/RuleConfiguration..."
      // — no dotted extension anywhere, so it is targetDirs-only.
      expect(artifact.tasks[4]!.targetFiles).toEqual([]);
      expect(artifact.tasks[4]!.targetDirs).toContain("src/Acme.Widgets/RuleConfiguration");

      // step8: "...in src/Acme.Widgets/build, with output under build/" — same,
      // dir-only (a bare "build/" isn't under a known prefix so it's ignored).
      expect(artifact.tasks[7]!.targetFiles).toEqual([]);
      expect(artifact.tasks[7]!.targetDirs).toContain("src/Acme.Widgets/build");
    });

    it("flags a dependsOn reference that names no task in this plan, without dropping it", () => {
      const planSynthesis = JSON.stringify({
        summary: "test plan",
        acceptance_criteria: ["a thing works"],
        actionItems: [
          { step: "do the first thing", owner_lens: "Eng", time_estimate: "1h", depends_on: [] },
          {
            step: "do the second thing",
            owner_lens: "Eng",
            time_estimate: "1h",
            depends_on: ["step1", "step99"],
          },
        ],
      });
      const artifact = buildSprintPlanArtifact({ sprintN: 1, runId: "run-x", planSynthesis });

      expect(artifact.source).toBe("structured");
      expect(artifact.tasks[1]!.dependsOn).toEqual(["step1", "step99"]);
      expect(artifact.notes.some((n) => n.includes("step2") && n.includes("step99"))).toBe(true);
    });
  });

  describe("fast-path structured side-channel (CouncilStats.structuredActionItems)", () => {
    it("keeps real structure (ids + dependsOn) even though planSynthesis is already flattened prose", () => {
      // Mirrors what synthesizePlanFromActionItems (council/index.ts) actually
      // flattens `depends_on` into: a plain priority-ordered bullet list with no
      // machine-readable dependency info. Without the side-channel this would
      // only ever produce a "text-derived" artifact.
      const structuredActionItems = [
        {
          step: "set up the project",
          owner_lens: "Eng",
          time_estimate: "2h",
          depends_on: [],
          acceptance_criteria: "builds",
        },
        {
          step: "implement rule A",
          owner_lens: "Eng",
          time_estimate: "3h",
          depends_on: ["step1"],
          acceptance_criteria: "rule A fires correctly",
        },
        {
          step: "implement rule B",
          owner_lens: "Eng",
          time_estimate: "3h",
          depends_on: ["step1"],
          acceptance_criteria: "rule B fires correctly",
        },
      ];
      const planSynthesis =
        "Sprint plan locked (3 steps):\n" +
        "- [high] set up the project\n" +
        "- [medium] implement rule A (3h) — accept: rule A fires correctly\n" +
        "- [medium] implement rule B (3h) — accept: rule B fires correctly";

      const artifact = buildSprintPlanArtifact({
        sprintN: 2,
        runId: "run-fast",
        planSynthesis,
        structuredActionItems,
      });

      expect(artifact.source).toBe("structured");
      expect(artifact.tasks).toHaveLength(3);
      expect(artifact.tasks[1]!.dependsOn).toEqual(["step1"]);
      expect(artifact.tasks[2]!.dependsOn).toEqual(["step1"]);
      expect(artifact.tasks[1]!.doneCriterion).toBe("rule A fires correctly");
    });
  });

  describe("text fallback", () => {
    it("prose-only input (fast path flattened with no side-channel) gives text-derived", () => {
      // This is exactly sprint-2-plan.md's shape from the live evidence: no JSON
      // header, just the flattened bullet list synthesizePlanFromActionItems emits.
      const planSynthesis =
        "Sprint plan locked (2 steps):\n" +
        "- [high] wire up the endpoint — accept: returns 200\n" +
        "- [low] add a smoke test — accept: test passes in CI";

      const artifact = buildSprintPlanArtifact({ sprintN: 3, runId: "run-prose", planSynthesis });

      expect(artifact.source).toBe("text-derived");
      expect(artifact.tasks.length).toBeGreaterThan(0);
      expect(artifact.tasks.every((t) => t.dependsOn.length === 0)).toBe(true);
      expect(artifact.tasks[0]!.title).toContain("wire up the endpoint");
      expect(artifact.tasks[0]!.doneCriterion).toContain("returns 200");
    });

    it("empty input gives none with no tasks and a note", () => {
      const artifact = buildSprintPlanArtifact({ sprintN: 4, runId: "run-empty", planSynthesis: "" });

      expect(artifact.source).toBe("none");
      expect(artifact.tasks).toEqual([]);
      expect(artifact.notes.length).toBeGreaterThan(0);
    });
  });

  describe("goal fallback", () => {
    it("falls back to sprintFocus when the plan carries no summary", () => {
      const planSynthesis = "Sprint plan locked (1 steps):\n- [high] do the thing — accept: it works";
      const artifact = buildSprintPlanArtifact({
        sprintN: 5,
        runId: "run-focus",
        planSynthesis,
        sprintFocus: "carry-over focus: fix the flaky endpoint",
      });
      expect(artifact.outcome.goal).toBe("carry-over focus: fix the flaky endpoint");
    });

    it("never invents a goal — empty + a note when neither summary nor sprintFocus exist", () => {
      const artifact = buildSprintPlanArtifact({ sprintN: 6, runId: "run-nogoal", planSynthesis: "" });
      expect(artifact.outcome.goal).toBe("");
      expect(artifact.notes.some((n) => n.toLowerCase().includes("no goal"))).toBe(true);
    });
  });

  describe("planHash (staleness key)", () => {
    it("is deterministic — the same planSynthesis always hashes the same", () => {
      const a = buildSprintPlanArtifact({ sprintN: 1, runId: "r1", planSynthesis: STRUCTURED_FIXTURE });
      const b = buildSprintPlanArtifact({ sprintN: 1, runId: "r1", planSynthesis: STRUCTURED_FIXTURE });
      expect(a.planHash).toBe(b.planHash);
    });

    it("changes when planSynthesis changes", () => {
      const a = buildSprintPlanArtifact({ sprintN: 1, runId: "r1", planSynthesis: "plan A" });
      const b = buildSprintPlanArtifact({ sprintN: 1, runId: "r1", planSynthesis: "plan B" });
      expect(a.planHash).not.toBe(b.planHash);
    });
  });
});
