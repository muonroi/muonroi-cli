import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as leader from "../../council/leader.js";
import { loadCatalog } from "../../models/registry.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { planningArtifact } from "../paths.js";
import { createPlanReviewBudget } from "../review-budget.js";
import { canExecute } from "../workflow-engine.js";

describe("native request-owned plan review budget (dfd06b45d9db)", () => {
  let cwd: string;
  let bash: BashTool;
  const prior = process.env.MUONROI_FLOW_NATIVE;
  const priorPolicy = process.env.MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION;
  beforeAll(async () => {
    await loadCatalog();
  });
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-budget-"));
    bash = new BashTool(cwd);
    process.env.MUONROI_FLOW_NATIVE = "1";
    // This suite pins the `stop` exhaustion policy; the default `proceed`
    // settlement is covered by plan-review-convergence.test.ts.
    process.env.MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION = "stop";
    vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: "test-leader" });
  });
  afterEach(async () => {
    await bash.cleanup();
    vi.restoreAllMocks();
    if (prior === undefined) delete process.env.MUONROI_FLOW_NATIVE;
    else process.env.MUONROI_FLOW_NATIVE = prior;
    if (priorPolicy === undefined) delete process.env.MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION;
    else process.env.MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION = priorPolicy;
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const debate = () =>
    vi.fn(
      async (_topic: string) =>
        '```council-verdict\n{"verdict":"revise","concerns":["Retain exact evidence"],"evidence":[]}\n```',
    );

  it("distinguishes exhausted review purchases from evidence and exact-result adjudication", async () => {
    const planReviewBudget = { used: 3, max: 3 };
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      executionRole: "orchestrator",
      depthTier: "heavy",
      planReviewBudget,
    });
    const status = JSON.parse((await tools.flow_status!.execute!({}, {} as never)) as string);
    expect(status.reviewBudget).toMatchObject({
      remaining: 0,
      exhausted: true,
      exhaustionBlocks: ["new_council", "plan_rewrite"],
      exhaustionDoesNotBlock: [
        "read_only_verification",
        "complete_unchanged_bound_review",
        "one_independent_plan_revalidation",
      ],
    });
    expect(status.nextActions.join(" ").toLowerCase()).toContain("read-only verification");
    expect(planReviewBudget.used).toBe(3);
  });

  it("refuses fourth review and rewrite without approving or replacing unresolved artifacts", async () => {
    const runDebate = debate();
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "heavy", runDebate });
    for (let i = 0; i < 3; i++) {
      await tools.flow_plan!.execute!({ body: `# Plan revision${i}\n1. Collect evidence\n2. Verify` }, {} as never);
      await tools.flow_plan_review!.execute!({}, {} as never);
    }
    const planBefore = readFileSync(planningArtifact(cwd, "PLAN.md"), "utf8");
    const reviewBefore = readFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "utf8");
    const rewrite = JSON.parse((await tools.flow_plan!.execute!({ body: "# Another rewrite" }, {} as never)) as string);
    const fourth = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(rewrite).toMatchObject({ blocked: true, code: "plan_review_budget_exhausted" });
    expect(fourth).toMatchObject({
      blocked: true,
      code: "plan_review_budget_exhausted",
      nextAction: "stop_and_report",
    });
    expect(runDebate).toHaveBeenCalledTimes(3);
    expect(readFileSync(planningArtifact(cwd, "PLAN.md"), "utf8")).toBe(planBefore);
    expect(readFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "utf8")).toBe(reviewBefore);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it("increments cycle and retains a shared allowance across registry rebuilds", async () => {
    const runDebate = debate(),
      planReviewBudget = { used: 0, max: 3 };
    const cycles: number[] = [];
    for (let i = 0; i < 3; i++) {
      const tools = createBuiltinTools(bash, "agent", {
        modelId: "test-model",
        depthTier: "heavy",
        runDebate,
        planReviewBudget,
      });
      await tools.flow_plan!.execute!({ body: `# Revision${i}\n1. Bound evidence` }, {} as never);
      const result = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
      cycles.push(result.review.recordedRevisionCycle);
    }
    expect(cycles).toEqual([0, 1, 2]);
    expect(runDebate.mock.calls[1]![0]).toContain("Prior council concerns (revision 1)");
    expect(runDebate.mock.calls[1]![0]).toContain("Retain exact evidence");
    const rebuilt = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      depthTier: "heavy",
      runDebate,
      planReviewBudget,
    });
    expect(JSON.parse((await rebuilt.flow_plan_review!.execute!({}, {} as never)) as string).blocked).toBe(true);
    expect(runDebate).toHaveBeenCalledTimes(3);
    const fresh = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      depthTier: "heavy",
      runDebate,
      planReviewBudget: { used: 0, max: 3 },
    });
    expect(JSON.parse((await fresh.flow_status!.execute!({}, {} as never)) as string).reviewBudget.remaining).toBe(3);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it.each(["approve", "revise", "block"])("a spent allowance preserves the actual %s verdict", async (verdict) => {
    const planReviewBudget = { used: 0, max: 1, stopRequested: false };
    const runDebate = vi.fn(
      async () => `\`\`\`council-verdict\n{"verdict":"${verdict}","concerns":[],"evidence":[]}\n\`\`\``,
    );
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      depthTier: "heavy",
      runDebate,
      planReviewBudget,
    });
    await tools.flow_plan!.execute!({ body: "# Plan\n1. Collect evidence" }, {} as never);
    const result = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(result.reviewBudget.remaining).toBe(0);
    expect(planReviewBudget.stopRequested).toBe(verdict !== "approve");
    expect(canExecute(cwd, "heavy").allowed).toBe(verdict === "approve");
  });

  it("does not reserve a cancelled call or give models an allowance reset", async () => {
    const planReviewBudget = { used: 0, max: 1 },
      runDebate = debate();
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      depthTier: "heavy",
      runDebate,
      planReviewBudget,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(tools.flow_plan_review!.execute!({}, { abortSignal: controller.signal } as never)).rejects.toThrow();
    expect(planReviewBudget.used).toBe(0);
    expect(runDebate).not.toHaveBeenCalled();
    await tools.flow_plan!.execute!({ body: "# Plan\n1. Read evidence" }, {} as never);
    await tools.flow_plan_review!.execute!({}, {} as never);
    const refused = JSON.parse(
      (await tools.flow_plan_review!.execute!({ force: true, max: 99, used: 0 }, {} as never)) as string,
    );
    expect(refused.code).toBe("plan_review_budget_exhausted");
    expect(runDebate).toHaveBeenCalledOnce();
  });

  it("accepts only a positive bounded host environment allowance", () => {
    const previous = process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS;
    try {
      for (const value of ["0", "-1", "NaN", "1.5"]) {
        process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS = value;
        expect(createPlanReviewBudget().max).toBe(3);
      }
      process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS = "2";
      expect(createPlanReviewBudget()).toEqual({ used: 0, max: 2 });
      process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS = "100";
      expect(createPlanReviewBudget().max).toBe(20);
    } finally {
      if (previous === undefined) delete process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS;
      else process.env.MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS = previous;
    }
  });
});
