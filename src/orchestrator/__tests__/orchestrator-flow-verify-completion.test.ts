/**
 * The orchestrator can record FLOW verification, so the root-goal completion
 * gate is satisfiable.
 *
 * Session 55c5b65b6938 (/ideal): the work finished (545/545 tests) but the single
 * `root_status=complete` claim was refused — implementationVerification had to be
 * `recorded_pass` and the orchestrator role exposed no `flow_verify`
 * (ORCHESTRATION_TOOLS ended at flow_plan_review). This drives the REAL tool
 * surface the orchestrator gets (createBuiltinTools + filterExecutionTools) and
 * the real completion facts the gate reads (readCompletionScope).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as leader from "../../council/leader.js";
import { closeDatabase } from "../../storage/db.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { ensurePlanningWorkspace } from "../../workflow/config-bridge.js";
import { planningArtifact } from "../../workflow/paths.js";
import { canExecute, readCompletionScope } from "../../workflow/workflow-engine.js";
import { filterExecutionTools } from "../orchestration-policy.js";
import { WorkingContext } from "../working-context.js";

const toolContext = { toolCallId: "fixture-flow-verify", messages: [] };
let home: string;
let cwd: string;
let bash: BashTool;

type Verdict = "approve" | "revise";
const verdictText = (verdict: Verdict) =>
  `\`\`\`council-verdict\n${JSON.stringify({
    verdict,
    concerns: verdict === "approve" ? [] : ["Goal not met by the diff"],
    evidence: ["VERIFY evidence"],
  })}\n\`\`\``;

function orchestratorTools(depth: "quick" | "standard", runDebate?: () => Promise<string>) {
  const native = createBuiltinTools(bash, "agent", {
    modelId: "fixture-model",
    executionRole: "orchestrator",
    depthTier: depth,
    runDebate,
  });
  return filterExecutionTools(native, native, "orchestrator");
}

const facts = () => {
  const scope = readCompletionScope(cwd);
  return { declaredPlanScope: scope.declaredPlanScope, implementationVerification: scope.implementationVerification };
};
const claimComplete = () => {
  const w = new WorkingContext("owner", cwd, []);
  w.update({ action: "update", expected_revision: 0, task_id: "t", goal: "wave", root_goal: "ROOT" });
  return w.update({ action: "update", expected_revision: w.snapshot().revision, root_status: "complete" }, facts);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "orch-flow-verify-"));
  cwd = join(home, "workspace");
  vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
  vi.stubEnv("MUONROI_CLI_HOME", home);
  vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: "fixture-leader" });
  ensurePlanningWorkspace(cwd, "fixture-model");
  bash = new BashTool(cwd);
});
afterEach(async () => {
  await bash.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeDatabase();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("orchestrator flow_execute / flow_verify / flow_ship", () => {
  it("exposes the three transition tools to the orchestrator", () => {
    const tools = orchestratorTools("quick");
    for (const name of ["flow_execute", "flow_verify", "flow_ship"]) expect(tools).toHaveProperty(name);
  });

  it("a recorded passing flow_verify lets root_status=complete through; without it the claim is refused", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      planningArtifact(cwd, "PLAN.md"),
      "# Experience endpoint\n1. Add the route\n## Acceptance\n- tests\n",
    );
    const before = claimComplete();
    expect(before.error).toContain("implementationVerification=missing");

    const tools = orchestratorTools("quick");
    const out = JSON.parse(
      (await tools.flow_verify!.execute!(
        { passed: true, evidence: "worker quiet-amber-heron ran 545/545 tests green" },
        toolContext,
      )) as string,
    );
    expect(out).toMatchObject({ ok: true, passed: true });
    expect(readFileSync(planningArtifact(cwd, "VERIFY.md"), "utf8")).toMatch(/^verdict: pass$/m);
    expect(readCompletionScope(cwd).implementationVerification).toBe("recorded_pass");

    const after = claimComplete();
    expect(after.error).toBeUndefined();
    expect(after.root_status).toBe("complete");
  });

  it("root_status=complete is refused while the host deliverable check has unmet requirements", () => {
    const w = new WorkingContext("owner", cwd, []);
    w.update({ action: "update", expected_revision: 0, task_id: "t", goal: "wave", root_goal: "ROOT" });
    const refused = w.update(
      { action: "update", expected_revision: w.snapshot().revision, root_status: "complete" },
      undefined,
      ["the goal asks for a commit but there are 0 commits since base commit a413be7e"],
    );
    expect(refused.error).toContain("deliverable check found unmet requirements");
    expect(refused.error).toContain("0 commits since base commit a413be7e");
    expect(refused.root_status).toBe("open");
    const accepted = w.update(
      { action: "update", expected_revision: w.snapshot().revision, root_status: "complete" },
      undefined,
      [],
    );
    expect(accepted.error).toBeUndefined();
  });

  it("a failing flow_verify records recorded_fail and keeps the claim refused", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planningArtifact(cwd, "PLAN.md"), "# Plan\n");
    const tools = orchestratorTools("quick");
    await tools.flow_verify!.execute!({ passed: false, evidence: "3 tests red" }, toolContext);
    expect(readCompletionScope(cwd).implementationVerification).toBe("recorded_fail");
    expect(claimComplete().error).toContain("implementationVerification=recorded_fail");
  });

  it("refuses passed=true without evidence (the deterministic floor)", async () => {
    const tools = orchestratorTools("quick");
    const out = JSON.parse((await tools.flow_verify!.execute!({ passed: true }, toolContext)) as string);
    expect(out.ok).toBe(false);
    expect(readCompletionScope(cwd).implementationVerification).toBe("missing");
  });

  it("at standard depth the verify council still adjudicates and overrides the self-reported pass", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planningArtifact(cwd, "PLAN.md"), "# Plan\n");
    const debate = vi.fn(async () => verdictText("revise"));
    const tools = orchestratorTools("standard", debate);
    const out = JSON.parse(
      (await tools.flow_verify!.execute!({ passed: true, evidence: "tests green" }, toolContext)) as string,
    );
    expect(debate).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ passed: false, councilConcerns: ["Goal not met by the diff"] });
    expect(readCompletionScope(cwd).implementationVerification).toBe("recorded_fail");

    const approving = vi.fn(async () => verdictText("approve"));
    const ok = JSON.parse(
      (await orchestratorTools("standard", approving).flow_verify!.execute!(
        { passed: true, evidence: "tests green" },
        toolContext,
      )) as string,
    );
    expect(ok.passed).toBe(true);
    expect(readCompletionScope(cwd).implementationVerification).toBe("recorded_pass");
  });

  it("flow_execute keeps its plan-verify gate for the orchestrator; flow_ship needs a verified phase", async () => {
    const tools = orchestratorTools("standard");
    expect(canExecute(cwd, "standard").allowed).toBe(false);
    const blocked = JSON.parse((await tools.flow_execute!.execute!({}, toolContext)) as string);
    expect(blocked.blocked).toBe(true);
    const ship = JSON.parse((await tools.flow_ship!.execute!({}, toolContext)) as string);
    expect(ship.blocked).toBe(true);
  });
});
