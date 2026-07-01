import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planningArtifact } from "../paths.js";
import {
  buildRoadmapFromPhasePlan,
  ensureProductPlanningWorkspace,
  syncRoadmapFromPhasePlan,
} from "../product-workspace.js";
import { readState } from "../workflow-engine.js";

describe("product-workspace", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("bootstraps PROJECT.md and ROADMAP.md for /ideal product kind", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-product-"));
    ensureProductPlanningWorkspace(tmp, {
      idea: "Build a counter app",
      sessionModelId: "deepseek-v4-flash",
      runId: "run-abc",
    });
    expect(existsSync(planningArtifact(tmp, "PROJECT.md"))).toBe(true);
    expect(existsSync(planningArtifact(tmp, "ROADMAP.md"))).toBe(true);
    const state = readState(tmp);
    expect(state.raw).toContain("Workflow Kind");
    expect(readFileSync(planningArtifact(tmp, "PROJECT.md"), "utf8")).toContain("counter app");
  });

  it("syncRoadmapFromPhasePlan writes gsd-compatible phase sections", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-product-"));
    const plan = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      phases: [
        {
          id: "phase-1",
          name: "Foundation",
          goal: "Scaffold project",
          successCriteria: ["App boots"],
          scope: "core",
          exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
          dependsOn: [],
          maxSprints: 2,
        },
        {
          id: "phase-2",
          name: "Features",
          goal: "Add counter UI",
          successCriteria: ["Counter increments"],
          scope: "ui",
          exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
          dependsOn: ["phase-1"],
          maxSprints: 2,
        },
      ],
    };
    const md = buildRoadmapFromPhasePlan("Counter", plan);
    expect(md).toContain("### Phase 1: Foundation");
    expect(md).toContain("**Depends on**: Nothing (first phase)");
    expect(md).toContain("**Depends on**: Phase 1");
    syncRoadmapFromPhasePlan(tmp, "Counter", plan);
    expect(readFileSync(planningArtifact(tmp, "ROADMAP.md"), "utf8")).toContain("Phase 2: Features");
  });
});
