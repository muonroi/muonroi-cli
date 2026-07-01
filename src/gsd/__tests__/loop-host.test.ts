import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { GsdLoopHost } from "../loop-host.js";
import { planningArtifact } from "../paths.js";
import { readPlanVerifyVerdict } from "../workflow-engine.js";

const SESSION_MODEL = "deepseek-v4-flash";
const GOOD_PLAN = `# Plan

1. Edit src/foo.ts
2. Acceptance: tests pass
`;

describe("GsdLoopHost", () => {
  let tmp: string;
  let host: GsdLoopHost;

  beforeAll(async () => {
    await loadCatalog();
    host = new GsdLoopHost();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("fires gsd-core loop render-hooks at plan:post", async () => {
    tmp = mkdtempSync(join(tmpdir(), "loop-host-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await host.firePoint("plan:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });

    expect(result.gsdHooks?.point).toBe("plan:post");
    expect(result.overlayRan).toBe(true);
    expect(existsSync(planningArtifact(tmp, "PLAN-REVIEW.md"))).toBe(true);
  });

  it("plan-review:post unlocks execute after council pass", async () => {
    tmp = mkdtempSync(join(tmpdir(), "loop-host-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    await host.firePoint("plan:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });
    await host.firePoint("plan-review:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });

    expect(readPlanVerifyVerdict(tmp)).toBe("pass");
  });
});
