/**
 * sprint-runner-item-debate.test.ts — C5 wiring proof.
 *
 * Proves the per-item debate (C1-C4) is actually reachable from a real
 * `/ideal` sprint: it triggers only when `selectDebatableItems` finds
 * something, argues via `runCouncil`'s `perRoundFocus`, records + applies a
 * ruling to `sprints/<n>-plan.json`, and never touches this sprint's own
 * verdict/outcome/criteria counts. Mirrors the mock harness in
 * `sprint-runner-project-registration.test.ts` (S6): `runCouncil` and
 * `evaluateDoneGate` are mocked so the assertions target ONLY C5's wiring,
 * not the council/done-gate internals those other slices already cover.
 */

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({ recordProductSpend: vi.fn(async () => undefined) }));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));
vi.mock("../plan-adherence-review.js", async (importOriginal) => {
  // Same rationale as the S6 harness: keep the adherence review a no-op so
  // only the debate/ruling calls under test are visible in the assertions.
  const actual = await importOriginal<typeof import("../plan-adherence-review.js")>();
  return {
    ...actual,
    // biome-ignore lint/correctness/useYield: matches the real AsyncGenerator<StreamChunk, AdherenceVerdict> contract; nothing worth emitting.
    runPlanAdherenceReview: vi.fn(async function* () {
      return { adherent: true, deviations: [], rounds: 0, stopReason: "approved", taskVerdicts: [] };
    }),
  };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCouncil } from "../../council/index.js";
import type { ItemDebateFocus } from "../../council/types.js";
import { readSprintItemDebate, readSprintPlanArtifact, writeSprintPlanArtifact } from "../../flow/run-artifacts.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { ITEM_RULING_SYSTEM_PROMPT } from "../item-debate-runner.js";
import { computePlanHash, type SprintPlanArtifact } from "../sprint-plan-artifact.js";
import { detectRoleFromSystem, runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
let testFlowDir = "/tmp/flow";

// The exact text the sprint-planning `runCouncil` mock returns below — every
// test that wants its own pre-seeded `sprints/<n>-plan.json` to be REUSED
// (rather than rebuilt from this text, which yields NO tasks since it is
// plain prose) must hash-match this string.
const PLAN_SYNTHESIS_TEXT = "synthesis text from council";

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "run-item-debate",
    flowDir: testFlowDir,
    cwd: "/tmp/cwd-item-debate",
    idea: "test idea",
    llm: {
      generate: vi.fn(async () => "default generate reply"),
      research: vi.fn(async () => "research"),
    },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    ...overrides,
  };
}

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

async function drain<T, R>(
  gen: AsyncGenerator<T, R, unknown>,
): Promise<{ chunks: T[]; result: R | undefined; error?: unknown }> {
  const chunks: T[] = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, result: value as R };
      chunks.push(value);
    }
  } catch (error) {
    return { chunks, result: undefined, error };
  }
}

/** A one-task plan artifact whose single task has NO done criterion — C1's
 * weakest signal (`vague-criterion`) fires on it and nothing else does, so
 * exactly one item is selected. Pre-seeded with a matching `planHash` so
 * sprint-runner REUSES it instead of rebuilding from `PLAN_SYNTHESIS_TEXT`
 * (which has no structure and would yield zero tasks). */
function makeVagueTaskPlan(runId: string, sprintN: number): SprintPlanArtifact {
  return {
    version: 1,
    sprintN,
    runId,
    planHash: computePlanHash(PLAN_SYNTHESIS_TEXT),
    source: "structured",
    outcome: { goal: "ship the feature", acceptance: [] },
    tasks: [
      {
        id: "step1",
        title: "Wire the new endpoint",
        doneCriterion: "",
        dependsOn: [],
        targetFiles: [],
        targetDirs: [],
        status: "pending",
      },
    ],
    notes: [],
  };
}

/** A council mock that plays BOTH roles the sprint pays for: the sprint-
 * planning debate (no `perRoundFocus`) and the item-debate (`perRoundFocus`
 * set) — distinguished the same way production code distinguishes them. */
function mockCouncilWithItemDebate(opts: { itemId: string; leaderReason?: string }) {
  (runCouncil as any).mockImplementation(async function* (
    _topic: string,
    _sessionModelId: string,
    _messages: unknown[],
    _runId: string,
    _llm: unknown,
    _respondToQuestion: unknown,
    _respondToPreflight: unknown,
    _processMessageFn: unknown,
    options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
  ) {
    if (options?.perRoundFocus && options.perRoundFocus.length > 0) {
      yield { type: "content", content: "\n> item-debate round...\n" };
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options.perRoundFocus[0]!.id,
          participants: ["Engineer", "Reviewer"],
          pairCount: 1,
          emergent: false,
          leaderReason: opts.leaderReason ?? "the debate settled on a concrete criterion",
        },
      };
      return "item debate synthesis";
    }
    yield { type: "content", content: "council planning..." };
    return PLAN_SYNTHESIS_TEXT;
  });
}

beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-item-debate-"));
  vi.clearAllMocks();
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE;
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (runVerifyOrchestration as any).mockResolvedValue({
    success: false,
    output: "VERIFY_FAIL\nsomething failed",
  });
  // FAIL keeps verdict.pass=false and verifyVerdict off "PASS", so neither F5
  // (goal-contradiction gate) nor self-verify fire an extra `llm.generate`
  // call that would confuse the item-debate ruling-call assertions below.
  (evaluateDoneGate as any).mockResolvedValue({
    pass: false,
    score: 0.4,
    failedCondition: "engineering_floor",
    reason: "FAIL",
  });
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return PLAN_SYNTHESIS_TEXT;
  });
});

afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("C5 — per-item debate wiring", () => {
  it("nothing selectable: no debate call, no plan change, and the sprint's verdict/nextFocus are unaffected", async () => {
    const ctx = makeCtx();
    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();
    expect(result).toBeDefined();

    // runCouncil was called exactly once — the sprint-planning debate — and
    // never again with `perRoundFocus` (which would mean an item-debate ran).
    const perRoundFocusCalls = (runCouncil as any).mock.calls.filter((c: any[]) => c[8]?.perRoundFocus);
    expect(perRoundFocusCalls.length).toBe(0);

    const record = await readSprintItemDebate(testFlowDir, ctx.runId, 1);
    expect(record).not.toBeNull();
    expect(record!.enabled).toBe(false);
    expect(record!.stopReason).toBe("no_items");
    expect(record!.items).toEqual([]);

    // The sprint's own verdict/outcome are exactly what evaluateDoneGate said —
    // nothing downstream perturbed them.
    expect(result!.scoreAfter).toBe(0.4);
    expect(result!.stage).toBe("retrospective");
  });

  it("one selectable item: the debate runs with perRoundFocus of length 1, the record is written, and a criterion ruling lands in the plan", async () => {
    mockCouncilWithItemDebate({ itemId: "step1" });
    const ruling = JSON.stringify({
      ruling: "tighten the vague criterion",
      changeKind: "criterion",
      change: { criterionText: "curl localhost:3000/new returns 200" },
    });
    const generate = vi.fn(async () => ruling);
    const ctx = makeCtx({ llm: { generate, research: vi.fn(async () => "research") } });

    await writeSprintPlanArtifact(testFlowDir, ctx.runId, makeVagueTaskPlan(ctx.runId, 1));

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();
    expect(result).toBeDefined();

    const perRoundFocusCalls = (runCouncil as any).mock.calls.filter((c: any[]) => c[8]?.perRoundFocus);
    expect(perRoundFocusCalls.length).toBe(1);
    expect(perRoundFocusCalls[0][8].perRoundFocus).toHaveLength(1);
    expect(perRoundFocusCalls[0][8].perRoundFocus[0].id).toBe("step1");

    const record = await readSprintItemDebate(testFlowDir, ctx.runId, 1);
    expect(record).not.toBeNull();
    expect(record!.enabled).toBe(true);
    expect(record!.stopReason).toBe("completed");
    expect(record!.items).toHaveLength(1);
    expect(record!.items[0]!.changeKind).toBe("criterion");

    const plan = await readSprintPlanArtifact(testFlowDir, ctx.runId, 1);
    expect(plan).not.toBeNull();
    expect(plan!.tasks[0]!.doneCriterion).toBe("curl localhost:3000/new returns 200");

    // This sprint's own verdict is unaffected by the ruling.
    expect(result!.scoreAfter).toBe(0.4);
    expect(result!.stage).toBe("retrospective");

    // The changes reach nextFocus for the next sprint.
    expect(result!.nextFocus).toContain("Item-debate rulings for next sprint");
    expect(result!.nextFocus).toContain("step1");
  });

  it("a no_verdict ruling changes nothing, and the record says so", async () => {
    mockCouncilWithItemDebate({ itemId: "step1" });
    // Not valid JSON at all → parseLeaderRuling falls through to NO_VERDICT.
    const generate = vi.fn(async () => "I could not decide.");
    const ctx = makeCtx({ llm: { generate, research: vi.fn(async () => "research") } });
    await writeSprintPlanArtifact(testFlowDir, ctx.runId, makeVagueTaskPlan(ctx.runId, 1));

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();

    const record = await readSprintItemDebate(testFlowDir, ctx.runId, 1);
    expect(record!.items[0]!.leaderRuling).toBe("no_verdict");
    expect(record!.items[0]!.changeKind).toBe("none");

    const plan = await readSprintPlanArtifact(testFlowDir, ctx.runId, 1);
    // Untouched — still the seeded empty done criterion.
    expect(plan!.tasks[0]!.doneCriterion).toBe("");
    expect(result!.scoreAfter).toBe(0.4);
  });

  it("the debate throws: the sprint still completes and the record carries the error", async () => {
    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
    ) {
      if (options?.perRoundFocus && options.perRoundFocus.length > 0) {
        throw new Error("council provider unavailable");
      }
      yield { type: "content", content: "council planning..." };
      return PLAN_SYNTHESIS_TEXT;
    });
    const ctx = makeCtx();
    await writeSprintPlanArtifact(testFlowDir, ctx.runId, makeVagueTaskPlan(ctx.runId, 1));

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    // The sprint itself must complete — a debate failure is not a sprint failure.
    expect(error).toBeUndefined();
    expect(result).toBeDefined();

    const record = await readSprintItemDebate(testFlowDir, ctx.runId, 1);
    expect(record!.enabled).toBe(false);
    expect(record!.stopReason).toBe("error");
    expect(record!.errorMessage).toContain("council provider unavailable");
    expect(record!.items).toEqual([]);

    const plan = await readSprintPlanArtifact(testFlowDir, ctx.runId, 1);
    expect(plan!.tasks[0]!.doneCriterion).toBe("");
  });

  it("MUONROI_IDEAL_ITEM_DEBATE=0: identical to today — no item-debate record, no extra runCouncil call", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE = "0";
    mockCouncilWithItemDebate({ itemId: "step1" });
    const ctx = makeCtx();
    await writeSprintPlanArtifact(testFlowDir, ctx.runId, makeVagueTaskPlan(ctx.runId, 1));

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();
    expect(result).toBeDefined();

    const perRoundFocusCalls = (runCouncil as any).mock.calls.filter((c: any[]) => c[8]?.perRoundFocus);
    expect(perRoundFocusCalls.length).toBe(0);

    const record = await readSprintItemDebate(testFlowDir, ctx.runId, 1);
    expect(record).toBeNull();

    const plan = await readSprintPlanArtifact(testFlowDir, ctx.runId, 1);
    expect(plan!.tasks[0]!.doneCriterion).toBe("");
    expect(result!.nextFocus ?? "").not.toContain("Item-debate rulings");
  });
});

describe("C5 — item-debate ruling calls are cost-attributable", () => {
  it("detectRoleFromSystem gives ITEM_RULING_SYSTEM_PROMPT its own role, distinct from every other prompt", () => {
    const role = detectRoleFromSystem(ITEM_RULING_SYSTEM_PROMPT);
    expect(role).toBeDefined();
    expect(role).not.toBe("judge");
    expect(role).not.toBe("leader");
    expect(role).toBe("item-debate-ruling");
  });

  it("does not collide with the existing leader/judge prompts' own role detection", () => {
    // Guards against a FUTURE edit accidentally reordering the branches so
    // this new one shadows an existing prompt's role.
    expect(detectRoleFromSystem("You are the leader of the council debate.")).toBe("leader");
    expect(detectRoleFromSystem("You judge whether a code change works against the goal.")).toBe("judge");
  });
});
