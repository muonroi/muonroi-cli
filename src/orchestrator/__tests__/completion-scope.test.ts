import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const owns = vi.hoisted(() => vi.fn());
vi.mock("../../storage/index.js", () => ({ sessionUsedFlowWorkflow: owns }));

import { ensurePlanningWorkspace } from "../../workflow/config-bridge.js";
import { planningArtifact } from "../../workflow/paths.js";
import { completionScopeGuidance, ownedCompletionScope } from "../completion-scope.js";

describe("host completion scope boundary", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "completion-scope-"));
    vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
    owns.mockReturnValue(true);
    ensurePlanningWorkspace(cwd, "fixture-model");
    writeFileSync(
      planningArtifact(cwd, "PLAN.md"),
      "# Full application delivery\n\nPreflight, implementation and executable acceptance.",
    );
    writeFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "verdict: pass\n");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it.each([
    [undefined, "missing"],
    ["Scanner preflight complete; all checks green.", "unstructured"],
    ["verdict: pass\n\nExecution report.", "recorded_pass"],
    ["verdict: pass\nverdict: fail\n", "recorded_fail"],
  ])("reports only recorded artifact facts without certifying the whole goal: %s", (body, expected) => {
    if (body !== undefined) writeFileSync(planningArtifact(cwd, "VERIFY.md"), body);
    const scope = ownedCompletionScope(cwd, "owner", "orchestrator")!;
    expect(scope.implementationVerification).toBe(expected);
    expect(scope.declaredPlanScope).toBe("Full application delivery");
    expect(scope.wholeTaskCompletion).toBe("unverified");
    expect(completionScopeGuidance(scope)).toContain("original user goal");
    expect(completionScopeGuidance(scope)).toContain(`"implementationVerification":"${expected}"`);
  });
  it("does not inherit an unrelated conversation's plan or alter worker/infrastructure replies", () => {
    owns.mockReturnValue(false);
    expect(ownedCompletionScope(cwd, "different-conversation", "orchestrator")).toBeNull();
    expect(ownedCompletionScope(cwd, "new-flow-conversation", "orchestrator", true)?.implementationVerification).toBe(
      "missing",
    );
    owns.mockReturnValue(true);
    for (const role of ["worker", "infrastructure"] as const)
      expect(ownedCompletionScope(cwd, "owner", role)).toBeNull();
    expect(ownedCompletionScope(cwd, undefined, "orchestrator")).toBeNull();
    vi.stubEnv("MUONROI_FLOW_NATIVE", "0");
    expect(ownedCompletionScope(cwd, "owner", "orchestrator")).toBeNull();
  });
});
