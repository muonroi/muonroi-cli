/**
 * Post-debate drift guard — session c4f78752a316.
 *
 * PIL is the authoritative intent classifier. For "đánh giá sâu cơ chế harness
 * TUI…" it correctly classified taskType=analyze. The leader LLM, however, chose
 * outputShape.kind="implementation_plan" with an implement-role roster, which made
 * the post-debate AskCard default to "generate_plan" (build a plan) — wrong for a
 * pure analysis request.
 *
 * planDebate now applies a deterministic backstop: when PIL taskType is
 * analysis-like, a drifted implementation_plan shape is coerced back to
 * "evaluation" so the synthesis stays the deliverable and the post-debate default
 * is save_exit (via pickPostDebateRecommendation's issue-#3 logic).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const IMPL_PLAN_OBJECT = {
  intentSummary: "Assess the harness TUI mechanism",
  stances: [
    { name: "Harness Architect", lens: "Design the v0.3 spec" },
    { name: "Real-world Tester", lens: "Stress the reconciliation contract" },
  ],
  outputShape: {
    kind: "implementation_plan",
    sections: [{ key: "steps", heading: "Steps", prompt: "build steps", shape: "text" as const }],
    guardrails: [],
  },
};

function mockPlannerDeps(object: unknown) {
  vi.doMock("ai", () => ({
    generateObject: vi.fn().mockResolvedValue({ object }),
    generateText: vi.fn(),
  }));
  vi.doMock("../../providers/keychain.js", () => ({
    loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
  }));
  vi.doMock("../../providers/runtime.js", () => ({
    detectProviderForModel: vi.fn().mockReturnValue("openai"),
    createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
    resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
  }));
  vi.doMock("../prompts.js", () => ({
    buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
  }));
}

const SPEC = {
  problemStatement: "đánh giá cơ chế harness",
  constraints: [],
  successCriteria: [],
  scope: "",
  rawQA: [],
};

async function runPlan(taskType?: string) {
  const { planDebate } = await import("../debate-planner.js");
  const gen = planDebate(SPEC, "gpt-4o", {} as never, undefined, undefined, taskType);
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe("planDebate — analysis intent shape backstop", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("coerces implementation_plan → evaluation when PIL taskType=analyze", async () => {
    mockPlannerDeps(IMPL_PLAN_OBJECT);
    const plan = await runPlan("analyze");
    expect(plan.outputShape.kind).toBe("evaluation");
  });

  it("leaves implementation_plan intact for a build intent (taskType=generate)", async () => {
    mockPlannerDeps(IMPL_PLAN_OBJECT);
    const plan = await runPlan("generate");
    expect(plan.outputShape.kind).toBe("implementation_plan");
  });

  it("does not touch a non-implementation shape under analyze", async () => {
    mockPlannerDeps({
      ...IMPL_PLAN_OBJECT,
      outputShape: { ...IMPL_PLAN_OBJECT.outputShape, kind: "evaluation" },
    });
    const plan = await runPlan("analyze");
    expect(plan.outputShape.kind).toBe("evaluation");
  });
});
