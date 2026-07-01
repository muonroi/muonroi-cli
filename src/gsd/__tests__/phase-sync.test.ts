import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningPhasesRoot } from "../paths.js";
import { ensureTaskRoadmap, extractPlanTitle, syncTaskPhaseOnPlan, syncTaskPhaseOnVerifyPass } from "../phase-sync.js";

describe("phase-sync", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-phase-sync-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("extractPlanTitle reads H1", () => {
    expect(extractPlanTitle("# My Feature\n\n1. step")).toBe("My Feature");
  });

  it("ensureTaskRoadmap creates ROADMAP when missing", () => {
    ensureTaskRoadmap(tmp, "Auth fix");
    expect(existsSync(join(tmp, ".planning", "ROADMAP.md"))).toBe(true);
  });

  it("syncTaskPhaseOnPlan creates phase dir and copies PLAN.md", () => {
    const planBody = "# Auth middleware\n\n1. Add guard\n2. Test\n";
    const result = syncTaskPhaseOnPlan(tmp, { planTitle: "Auth middleware", planBody });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.phaseDirName).toBeTruthy();
    const phases = readdirSync(planningPhasesRoot(tmp));
    expect(phases.length).toBeGreaterThan(0);
    const planInPhase = readFileSync(join(planningPhasesRoot(tmp), phases[0]!, "PLAN.md"), "utf8");
    expect(planInPhase).toContain("Auth middleware");
  });

  it("syncTaskPhaseOnPlan is idempotent on second call", () => {
    const planBody = "# Same task\n\n1. step\n";
    syncTaskPhaseOnPlan(tmp, { planTitle: "Same task", planBody });
    const countAfterFirst = readdirSync(planningPhasesRoot(tmp)).length;
    syncTaskPhaseOnPlan(tmp, { planTitle: "Same task revised", planBody: "# Same task\n\n1. revised\n" });
    expect(readdirSync(planningPhasesRoot(tmp)).length).toBe(countAfterFirst);
  });

  it("syncTaskPhaseOnVerifyPass writes verification and completes phase", () => {
    const planBody = "# Verify flow\n\n1. step\n";
    syncTaskPhaseOnPlan(tmp, { planTitle: "Verify flow", planBody });
    const result = syncTaskPhaseOnVerifyPass(tmp, { evidence: "bun test — 12 passed" });
    expect(result.ok).toBe(true);
    expect(result.phaseNumber).toBeTruthy();
    const phaseDir = result.phaseDirName!;
    const files = readdirSync(join(planningPhasesRoot(tmp), phaseDir));
    expect(files.some((f) => f.endsWith("-VERIFICATION.md"))).toBe(true);
    expect(files).toContain("SUMMARY.md");
  });
});
