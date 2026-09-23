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

  describe("D5 — shape tolerance (a second live shape, run muauw6u93e1c)", () => {
    // Live evidence: run muauw6u93e1c's fast-path structuredActionItems were
    // shaped `{key, value}` — an index string and the actual work
    // description — matching NO known alias for description/criterion/deps.
    // Before D5 this made `title` the raw JSON.stringify blob and left
    // `doneCriterion` empty with no explanation.
    const keyValueItems = [
      { key: "1", value: "Add the packaging property to the project file at the first property group" },
      { key: "2", value: "Run the build to confirm the package is produced automatically" },
      { key: "3", value: "Run the packaging script to produce the package into the local feed directory" },
    ];

    it("never lets a JSON blob become the title — uses the sole long string field instead", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-muauw6u93e1c",
        planSynthesis: "irrelevant prose",
        structuredActionItems: keyValueItems,
      });

      expect(artifact.source).toBe("structured");
      expect(artifact.tasks).toHaveLength(3);
      expect(artifact.tasks[0]!.title).toBe(
        "Add the packaging property to the project file at the first property group",
      );
      expect(artifact.tasks[0]!.title).not.toContain("{");
      expect(artifact.tasks[0]!.title).not.toContain('"key"');
    });

    it("leaves doneCriterion empty AND records a note naming the shape when no criterion field matches", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-muauw6u93e1c",
        planSynthesis: "irrelevant prose",
        structuredActionItems: keyValueItems,
      });

      expect(artifact.tasks[0]!.doneCriterion).toBe("");
      expect(artifact.notes.some((n) => n.includes("step1") && n.toLowerCase().includes("criterion"))).toBe(true);
    });

    it("records which raw shape was detected, for future diagnosability", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-muauw6u93e1c",
        planSynthesis: "irrelevant prose",
        structuredActionItems: keyValueItems,
      });

      expect(
        artifact.notes.some(
          (n) => n.includes("Action-item shape detected") && n.includes("key") && n.includes("value"),
        ),
      ).toBe(true);
    });

    it("matches known aliases case-insensitively (Step/Acceptance_Criteria/DependsOn)", () => {
      const items = [
        { Step: "do the first thing", Acceptance_Criteria: "it builds", DependsOn: [] },
        { Step: "do the second thing", Acceptance_Criteria: "it passes", DependsOn: ["step1"] },
      ];
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-case",
        planSynthesis: "irrelevant",
        structuredActionItems: items,
      });

      expect(artifact.tasks[0]!.title).toBe("do the first thing");
      expect(artifact.tasks[0]!.doneCriterion).toBe("it builds");
      expect(artifact.tasks[1]!.dependsOn).toEqual(["step1"]);
    });

    it("derives a title from the criterion's first clause when there is a criterion but no description field", () => {
      const items = [{ acceptance_criteria: "The endpoint returns 200. Extra detail follows here." }];
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-criterion-title",
        planSynthesis: "irrelevant",
        structuredActionItems: items,
      });

      expect(artifact.tasks[0]!.title).toBe("The endpoint returns 200.");
      expect(artifact.tasks[0]!.title).not.toContain("{");
    });

    it("a short single string field (an id, not a description) does not trigger the sole-long-string fallback", () => {
      const items = [{ id: "abc123" }];
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-short-string",
        planSynthesis: "irrelevant",
        structuredActionItems: items,
      });

      expect(artifact.tasks[0]!.title).not.toBe("abc123");
      expect(artifact.tasks[0]!.title).not.toContain("{");
    });
  });

  describe("D6 — the sole-long-string fallback only adopts a real work description", () => {
    // Reproduced against b70db771's parent: the fallback adopted ANY single
    // remaining string field of >= 20 chars, so an owner note, a UUID, or a
    // time estimate each became the task `title`. Two causes: (1) `owner_lens`
    // / `time_estimate` were read by direct key access, never entered the
    // `used` set, and stayed eligible as "the sole long string"; (2) the
    // 20-char floor admits a pure identifier (a UUID is 36 chars).
    const build = (item: Record<string, unknown>) =>
      buildSprintPlanArtifact({ sprintN: 1, runId: "r1", planSynthesis: "", structuredActionItems: [item] });

    it("never titles a task with an owner note (owner_lens is consumed, not a description)", () => {
      const artifact = build({ step_id: 3, owner_lens: "the platform team lead responsible for auth" });
      expect(artifact.tasks[0]!.title).not.toBe("the platform team lead responsible for auth");
      expect(artifact.tasks[0]!.title).toContain("Untitled task step1");
      expect(artifact.tasks[0]!.owner).toBe("the platform team lead responsible for auth");
    });

    it("never titles a task with a UUID (structurally an identifier, not prose)", () => {
      const artifact = build({ ref: 1, correlation_id: "550e8400-e29b-41d4-a716-446655440000" });
      expect(artifact.tasks[0]!.title).not.toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(artifact.tasks[0]!.title).toContain("Untitled task step1");
    });

    it("never titles a task with a time estimate (time_estimate is consumed, not a description)", () => {
      const artifact = build({ n: 2, time_estimate: "about three and a half working days" });
      expect(artifact.tasks[0]!.title).not.toBe("about three and a half working days");
      expect(artifact.tasks[0]!.title).toContain("Untitled task step1");
      expect(artifact.tasks[0]!.estimate).toBe("about three and a half working days");
    });

    it("still titles the {key, value} shape the fallback exists for (run muauw6u93e1c)", () => {
      const artifact = build({ key: "1", value: "Add InternalsVisibleTo so the test project compiles" });
      expect(artifact.tasks[0]!.title).toBe("Add InternalsVisibleTo so the test project compiles");
    });

    it("still adopts a genuinely unrecognized description key — the fallback's real job", () => {
      const artifact = build({ idx: "1", work_summary: "Add InternalsVisibleTo so the test project compiles" });
      expect(artifact.tasks[0]!.title).toBe("Add InternalsVisibleTo so the test project compiles");
      expect(
        artifact.notes.some((n) => n.includes("step1") && n.includes('"work_summary"') && n.includes("sourced from")),
      ).toBe(true);
    });

    it("keeps a short imperative task description — the rule is about SHAPE, not length", () => {
      const artifact = build({ idx: "1", work_summary: "Fix the failing InternalsVisibleTo test" });
      expect(artifact.tasks[0]!.title).toBe("Fix the failing InternalsVisibleTo test");
    });

    it("records a diagnostic note naming the rejected field and the reason", () => {
      const artifact = build({ ref: 1, correlation_id: "550e8400-e29b-41d4-a716-446655440000" });
      const note = artifact.notes.find((n) => n.includes("step1") && n.includes('"correlation_id"'));
      expect(note).toBeDefined();
      expect(note).toContain("NOT adopted");
      expect(note!.toLowerCase()).toMatch(/identifier|single token/);
    });

    it("records WHY a consumed field was not reused as the description", () => {
      const artifact = build({ step_id: 3, owner_lens: "the platform team lead responsible for auth" });
      const note = artifact.notes.find((n) => n.includes("step1") && n.includes('"owner_lens"'));
      expect(note).toBeDefined();
      expect(note).toContain("NOT adopted");
      expect(note).toContain("owner");
    });

    it("falls to the acceptance criterion, not the identifier, when both are present", () => {
      const artifact = build({
        correlation_id: "550e8400-e29b-41d4-a716-446655440000",
        acceptance_criteria: "The package restores cleanly. Extra detail.",
      });
      expect(artifact.tasks[0]!.title).toBe("The package restores cleanly.");
      expect(artifact.notes.some((n) => n.includes("step1") && n.includes("acceptance criterion"))).toBe(true);
    });

    describe("shape rule boundaries", () => {
      const titleOf = (v: string) => build({ idx: "1", work_summary: v }).tasks[0]!.title;

      it("rejects a bare hex blob", () => {
        expect(titleOf("a3f9c2e18b4d7f6019283746abcdef01")).toContain("Untitled task");
      });

      it("rejects a base64-ish blob", () => {
        expect(titleOf("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toContain("Untitled task");
      });

      it("rejects a bare path (a single token with no whitespace)", () => {
        expect(titleOf("src/product-loop/sprint-plan-artifact.ts")).toContain("Untitled task");
      });

      it("rejects an ISO timestamp", () => {
        expect(titleOf("2026-09-23T14:30:00.000Z")).toContain("Untitled task");
      });

      it("rejects a whitespace-separated list of identifiers (no prose word at all)", () => {
        expect(titleOf("550e8400-e29b-41d4-a716-446655440000 660e8400-e29b-41d4-a716-446655440001")).toContain(
          "Untitled task",
        );
      });

      it("accepts prose that merely CONTAINS a path or an identifier", () => {
        expect(titleOf("Update src/product-loop/sprint-plan-artifact.ts to bound the title")).toBe(
          "Update src/product-loop/sprint-plan-artifact.ts to bound the title",
        );
      });

      it("accepts a space-less script (CJK prose is not an identifier)", () => {
        const cjk = "修复打包脚本使其能够生成本地源中的程序包文件";
        expect(titleOf(cjk)).toBe(cjk);
      });

      it("declines rather than guesses when two fields are both plausible descriptions", () => {
        const artifact = build({
          work_summary: "Add InternalsVisibleTo so the test project compiles",
          rationale: "The test project cannot see the internal symbols it asserts on",
        });
        expect(artifact.tasks[0]!.title).toContain("Untitled task step1");
        expect(artifact.notes.some((n) => n.includes("step1") && n.includes("could each be the description"))).toBe(
          true,
        );
      });
    });

    it("rejects an id-shaped KEY even when its value reads as prose", () => {
      const artifact = build({ n: 1, run_id: "run mu54vrme4c87 sprint two" });
      expect(artifact.tasks[0]!.title).toContain("Untitled task step1");
      expect(artifact.notes.some((n) => n.includes('"run_id"') && n.includes("identifier"))).toBe(true);
    });

    it("rejects an owner/estimate SYNONYM key the direct lookups do not consume", () => {
      const owned = build({ n: 1, assignee: "the platform team lead responsible for billing" });
      expect(owned.tasks[0]!.title).toContain("Untitled task step1");
      const estimated = build({ n: 1, eta: "about three and a half working days" });
      expect(estimated.tasks[0]!.title).toContain("Untitled task step1");
    });
  });

  describe("D5 — goal/acceptance fallback beyond sprintFocus", () => {
    it("falls back to the active backlog item's own text when there is no summary and no sprintFocus", () => {
      const planSynthesis = "Sprint plan locked (1 steps):\n- [high] do the thing — accept: it works";
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-backlog-goal",
        planSynthesis,
        backlogFocus: "Ship the CodeStandards NuGet package — the analyzer must warn in the IDE",
      });

      expect(artifact.outcome.goal).toBe("Ship the CodeStandards NuGet package — the analyzer must warn in the IDE");
      expect(artifact.notes.some((n) => n.toLowerCase().includes("backlog item"))).toBe(true);
    });

    it("prefers sprintFocus over backlogFocus when both are given", () => {
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-precedence",
        planSynthesis: "",
        sprintFocus: "the carried-over focus",
        backlogFocus: "the backlog item text",
      });

      expect(artifact.outcome.goal).toBe("the carried-over focus");
    });

    it("falls back to criteria.json rows when the plan text yields no acceptance criteria", () => {
      const planSynthesis = "Sprint plan locked (1 steps):\n- [high] do the thing";
      const artifact = buildSprintPlanArtifact({
        sprintN: 1,
        runId: "run-criteria-fallback",
        planSynthesis,
        criteriaFallback: ["The package builds successfully", "Visual Studio shows the warning"],
      });

      expect(artifact.outcome.acceptance).toEqual([
        "The package builds successfully",
        "Visual Studio shows the warning",
      ]);
      expect(artifact.notes.some((n) => n.includes("criteria.json"))).toBe(true);
    });

    it("never invents acceptance criteria when there is no fallback either", () => {
      const artifact = buildSprintPlanArtifact({ sprintN: 1, runId: "run-no-acceptance", planSynthesis: "" });
      expect(artifact.outcome.acceptance).toEqual([]);
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
