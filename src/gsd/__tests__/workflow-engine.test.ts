import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningArtifact } from "../paths.js";
import { advancePhase, canExecute, readPlanVerifyVerdict, readState, setStateField } from "../workflow-engine.js";

describe("workflow-engine", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("bootstraps .planning/ and reads STATE.md phase", () => {
    tmp = mkdtempSync(join(tmpdir(), "wf-"));
    ensurePlanningWorkspace(tmp, "test-model");
    const state = readState(tmp);
    expect(state.phase).toBe("discuss");
    advancePhase(tmp, "plan");
    expect(readState(tmp).phase).toBe("plan");
  });

  it("canExecute blocks until PLAN-VERIFY pass at standard depth", () => {
    tmp = mkdtempSync(join(tmpdir(), "wf-"));
    ensurePlanningWorkspace(tmp, "test-model");
    setStateField(tmp, "Depth", "standard");
    expect(canExecute(tmp, "standard").allowed).toBe(false);

    writeFileSync(planningArtifact(tmp, "PLAN-VERIFY.md"), "# PLAN-VERIFY\n\nverdict: pass\n", "utf8");
    setStateField(tmp, "Plan Verified", "yes");
    advancePhase(tmp, "execute");
    expect(canExecute(tmp, "standard").allowed).toBe(true);
    expect(readPlanVerifyVerdict(tmp)).toBe("pass");
  });

  it("canExecute allows quick depth without plan-verify", () => {
    tmp = mkdtempSync(join(tmpdir(), "wf-"));
    ensurePlanningWorkspace(tmp, "test-model");
    expect(canExecute(tmp, "quick").allowed).toBe(true);
  });
});
