/**
 * backlog-builder.test.ts — P6 unit tests for buildBacklog.
 *
 * Tests:
 *  A: 3-feature plan → 3 items with correct v1/v2 distribution.
 *  B: acceptance_criteria matching — "login" criterion attaches to login item.
 *  C: effort estimation routes through pickCouncilTaskModel("effort_estimate", ...).
 *  D: derivedFromClarifyId is deterministic for the same spec.
 */

import { describe, expect, it, vi } from "vitest";

// Mock pickCouncilTaskModel to capture the task tag.
vi.mock("../../council/leader.js", () => ({
  pickCouncilTaskModel: vi.fn((_task: string, leaderModelId: string) => leaderModelId),
}));

import { pickCouncilTaskModel } from "../../council/leader.js";
import type { ClarifiedSpec, CouncilLLM } from "../../council/types.js";
import { buildBacklog } from "../backlog-builder.js";
import type { ImplementationPlanArtifact } from "../types.js";

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Build a simple todo app",
    constraints: ["must run offline"],
    successCriteria: ["user can create tasks"],
    scope: "web app",
    rawQA: [],
  };
}

function makePlan(): ImplementationPlanArtifact {
  return {
    entities: [
      { name: "task", fields: "id:uuid, title:string, done:boolean" },
      { name: "user", fields: "id:uuid, email:string" },
    ],
    endpoints: [
      { method: "POST", path: "/tasks", auth_required: true },
      { method: "GET", path: "/users/me", auth_required: true },
    ],
    acceptance_criteria: [
      "user can log in with email/password",
      "user can create a task with a title",
      "user can mark a task as done",
    ],
    mvp_definition: [
      { feature: "login", included_in_v1: "yes", reason: "Core auth" },
      { feature: "task management", included_in_v1: "yes", reason: "Primary value" },
      { feature: "multi-tenant", included_in_v1: "no", reason: "Out of scope for v1" },
    ],
  };
}

function makeLlm(effortResponse = "[1, 3, 5]"): CouncilLLM {
  return {
    generate: vi.fn(async (_model: string, _system: string, _prompt: string) => effortResponse),
    research: vi.fn(async () => ""),
    debate: vi.fn(async () => ({ text: "", toolCalls: [] })),
  };
}

describe("buildBacklog (P6)", () => {
  it("Test A: produces 3 BacklogItems with correct v1/v2 distribution", async () => {
    const backlog = await buildBacklog({
      runId: "run-1",
      productSlug: "todo-app",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm: makeLlm(),
      leaderModelId: "leader-model",
      costAware: true,
    });

    expect(backlog.items).toHaveLength(3);

    const v1Items = backlog.items.filter((i) => i.mvp_priority === "v1");
    const v2Items = backlog.items.filter((i) => i.mvp_priority === "v2");
    expect(v1Items).toHaveLength(2); // login + task management
    expect(v2Items).toHaveLength(1); // multi-tenant
    expect(v2Items[0].title).toBe("multi-tenant");
    expect(v2Items[0].deferral_reason).toBe("Out of scope for v1");
  });

  it("Test B: acceptance criteria matching — 'login' criterion attaches to login item", async () => {
    const backlog = await buildBacklog({
      runId: "run-1",
      productSlug: "todo-app",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm: makeLlm(),
      leaderModelId: "leader-model",
      costAware: true,
    });

    const loginItem = backlog.items.find((i) => i.title === "login");
    expect(loginItem).toBeDefined();
    // "user can log in with email/password" should match "login" keyword
    expect(loginItem!.acceptance_criteria.some((c) => c.includes("log in"))).toBe(true);
  });

  it("Test C: effort estimation calls pickCouncilTaskModel with task='effort_estimate'", async () => {
    // Clear prior calls so we can assert on calls from this test only.
    (pickCouncilTaskModel as ReturnType<typeof vi.fn>).mockClear();

    const llm = makeLlm();
    await buildBacklog({
      runId: "run-1",
      productSlug: "todo-app",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm,
      leaderModelId: "my-leader-model",
      costAware: true,
    });

    const calls = (pickCouncilTaskModel as ReturnType<typeof vi.fn>).mock.calls;
    const effortCall = calls.find((c) => c[0] === "effort_estimate");
    expect(effortCall).toBeDefined();
    expect(effortCall![1]).toBe("my-leader-model");
  });

  it("Test D: derivedFromClarifyId is deterministic for the same spec", async () => {
    const spec = makeSpec();
    const plan = makePlan();

    const a = await buildBacklog({
      runId: "run-a",
      productSlug: "todo",
      spec,
      implementationPlan: plan,
      llm: makeLlm(),
      leaderModelId: "m",
      costAware: false,
    });

    const b = await buildBacklog({
      runId: "run-b",
      productSlug: "todo",
      spec,
      implementationPlan: plan,
      llm: makeLlm(),
      leaderModelId: "m",
      costAware: false,
    });

    expect(a.derivedFromClarifyId).toBe(b.derivedFromClarifyId);
    expect(a.derivedFromClarifyId).toHaveLength(16);
  });

  it("effortPoints are parsed from LLM response", async () => {
    const backlog = await buildBacklog({
      runId: "run-1",
      productSlug: "todo",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm: makeLlm("[1, 3, 5]"),
      leaderModelId: "m",
      costAware: true,
    });

    // 3 items: effort 1, 3, 5 respectively
    expect(backlog.items[0].effortPoints).toBe(1);
    expect(backlog.items[1].effortPoints).toBe(3);
    expect(backlog.items[2].effortPoints).toBe(5);
  });

  it("defaults effortPoints to 3 when LLM response is unparseable", async () => {
    const backlog = await buildBacklog({
      runId: "run-1",
      productSlug: "todo",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm: makeLlm("invalid json here"),
      leaderModelId: "m",
      costAware: true,
    });

    for (const item of backlog.items) {
      expect(item.effortPoints).toBe(3);
    }
  });

  it("status defaults to 'backlog' for all items", async () => {
    const backlog = await buildBacklog({
      runId: "run-1",
      productSlug: "todo",
      spec: makeSpec(),
      implementationPlan: makePlan(),
      llm: makeLlm(),
      leaderModelId: "m",
      costAware: false,
    });

    for (const item of backlog.items) {
      expect(item.status).toBe("backlog");
    }
  });
});
