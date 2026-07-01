import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningArtifact } from "../paths.js";
import { runPlanCouncil } from "../plan-council.js";
import { perspectivesForDepth } from "../plan-council-prompts.js";
import { canExecute, readPlanVerifyVerdict } from "../workflow-engine.js";

const GOOD_PLAN = `# Plan

1. Edit src/foo.ts — add export
2. Add test in src/foo.test.ts
3. Acceptance: bun test src/foo.test.ts passes
`;

const SESSION_MODEL = "deepseek-v4-flash";

describe("plan-council", () => {
  let tmp: string;

  beforeAll(async () => {
    await loadCatalog();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("skips council at quick depth", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "quick" });
    expect(result.skipped).toBe(true);
    expect(perspectivesForDepth("quick")).toHaveLength(0);
  });

  it("runs 2 perspectives at standard depth and writes PLAN-VERIFY.md", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "standard" });
    expect(result.skipped).toBe(false);
    expect(result.perspectives).toHaveLength(2);
    expect(existsSync(planningArtifact(tmp, "PLAN-REVIEW.md"))).toBe(true);
    expect(existsSync(planningArtifact(tmp, "PLAN-VERIFY.md"))).toBe(true);
    expect(readPlanVerifyVerdict(tmp)).toBe("pass");
    expect(canExecute(tmp, "standard").allowed).toBe(true);
  });

  it("runs 5 perspectives at heavy depth", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "heavy" });
    expect(result.perspectives.length).toBeGreaterThanOrEqual(3);
    const review = readFileSync(planningArtifact(tmp, "PLAN-REVIEW.md"), "utf8");
    expect(review).toContain("Leader:");
  });

  it("blocks execute when plan is too short", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), "fix it", "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "standard" });
    expect(result.verdict).not.toBe("pass");
    expect(canExecute(tmp, "standard").allowed).toBe(false);
  });
});
