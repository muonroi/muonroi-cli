/**
 * `/ideal` has no limits — the product-loop half (spend caps, sprint ceilings,
 * ritual floors, context byte caps, adherence rounds).
 *
 * User decision (verbatim): "bỏ toàn bộ giới hạn ngân sách ra khỏi cho tôi ideal
 * không có giới hạn gì cả đặc biệt là ngân sách".
 *
 * Every loop that lost its ceiling here must still END when nothing progresses —
 * those tests sit next to the ones that prove the ceiling is gone.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import type { CouncilLLM } from "../../council/types.js";
import { loadCatalog } from "../../models/registry.js";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import { parseIdealArgs } from "../../ui/slash/ideal.js";
import * as ledger from "../../usage/ledger.js";
import * as productLedger from "../../usage/product-ledger.js";
import { CapBreachError } from "../../usage/types.js";
import { buildSprintContext, digestSprintIntoPhase, handoffPhaseToNext } from "../context-policy.js";
import { formatCostPreview, previewRunCost } from "../cost-preview.js";
import { IDEAL_LOOP_DEFAULTS } from "../loop-defaults.js";
import { recordPhaseEnd, recordPhaseStart } from "../phase-budget.js";
import { generatePhasePlan } from "../phase-plan.js";
import { generateSprintReview, runRetro, runStandup } from "../phase-rituals.js";
import { runPhases } from "../phase-runner.js";
import { runPlanAdherenceReview } from "../plan-adherence-review.js";
import { createProductLlm } from "../sprint-runner.js";

beforeAll(async () => {
  await loadCatalog();
});

async function drain<T>(gen: AsyncGenerator<unknown, T, unknown>): Promise<{ value: T; chunks: unknown[] }> {
  const chunks: unknown[] = [];
  while (true) {
    const n = await gen.next();
    if (n.done) return { value: n.value, chunks };
    chunks.push(n.value);
  }
}

const contentOf = (chunks: unknown[]) =>
  chunks.map((c) => String((c as { content?: unknown }).content ?? "")).join("\n");

describe("A — spend flags", () => {
  it("--max-cost is neither capped nor required, and never becomes a cap", () => {
    const r = parseIdealArgs(["--max-cost", "9999", "build", "the", "analyzer"]);
    expect(r.subcommand).toBe("start");
    expect(r.idea).toBe("build the analyzer");
    expect(r.flags.maxCost).toBeUndefined();
    expect(r.warnings.some((w) => /--max-cost/.test(w) && /ignored/i.test(w))).toBe(true);
  });

  it("a plain start carries no cost cap, no token budget and no sprint ceiling", () => {
    const r = parseIdealArgs(["build", "the", "analyzer"]);
    expect(r.flags.maxCost).toBeUndefined();
    expect(r.flags.budgetTokens).toBeUndefined();
    expect(r.flags.maxSprints).toBeUndefined();
    expect(IDEAL_LOOP_DEFAULTS).not.toHaveProperty("maxCost");
    expect(IDEAL_LOOP_DEFAULTS).not.toHaveProperty("maxSprints");
  });

  it("--budget-tokens is ignored with a warning", () => {
    const r = parseIdealArgs(["--budget-tokens", "1000", "idea"]);
    expect(r.subcommand).toBe("start");
    expect(r.flags.budgetTokens).toBeUndefined();
    expect(r.warnings.some((w) => /--budget-tokens/.test(w) && /ignored/i.test(w))).toBe(true);
  });

  it("--max-sprints has no upper range (an explicit ceiling the user typed is still honoured)", () => {
    const r = parseIdealArgs(["--max-sprints", "50", "idea"]);
    expect(r.subcommand).toBe("start");
    expect(r.flags.maxSprints).toBe(50);
  });
});

describe("A — the product LLM wrapper is not refused on spend", () => {
  let home: string;
  const savedHome = process.env.MUONROI_CLI_HOME;
  beforeEach(async () => {
    home = path.join(os.tmpdir(), `ideal-spend-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(home, { recursive: true });
    process.env.MUONROI_CLI_HOME = home;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("generate() and research() run even when both the per-run and the monthly ledger would refuse, and spend is still recorded", async () => {
    vi.spyOn(productLedger, "getProductSpentUsd").mockResolvedValue(1_000_000);
    vi.spyOn(ledger, "reserve").mockResolvedValue(new CapBreachError(1_000_000, 0, 1, 15));
    const appended = vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);
    const base = {
      generate: vi.fn(async () => "planned"),
      research: vi.fn(async () => "researched"),
      debate: vi.fn(async () => "debated"),
    } as unknown as CouncilLLM;
    const model = getTestModels().balanced;
    const llm = createProductLlm(base, "run-sponsored");
    await expect(llm.generate(model, "You are the product owner", "plan it", 512)).resolves.toBe("planned");
    await expect(llm.research(model, "topic", "context")).resolves.toBe("researched");
    // Measurement kept: both calls reached the per-run ledger.
    expect(appended).toHaveBeenCalledTimes(2);
  });
});

describe("A — discretionary calls no longer degrade on low remaining spend", () => {
  const leader = () => ({
    generate: vi.fn().mockResolvedValue({
      content: '{"wentWell":[],"toImprove":[],"nextSprintFocus":"x","blockers":[],"decisions":[],"nextStep":"y"}',
      costUsd: 0,
    }),
  });
  const sprintState = { sprintN: 1, scoreBefore: 0, scoreAfter: 0.5, criteriaMet: 1, totalCriteria: 2 };

  it("sprint review, retro and phase handoff call the leader with zero remaining spend", async () => {
    const l1 = leader();
    const review = await generateSprintReview({
      sprintState,
      phase: { id: "phase-1" } as never,
      leader: l1,
      capUsd: 50,
      remainingUsd: 0,
      backoffDelays: [1],
    } as never);
    expect(l1.generate).toHaveBeenCalled();
    expect(review.usedFallback).toBe(false);

    const l2 = leader();
    await expect(
      runRetro({ sprintState, leader: l2, capUsd: 50, remainingUsd: 0, backoffDelays: [1] } as never),
    ).resolves.toBeDefined();
    expect(l2.generate).toHaveBeenCalled();

    const l3 = leader();
    const handoff = await handoffPhaseToNext({
      phaseId: "phase-1",
      sprintsExecuted: 1,
      criteriaMet: 1,
      totalCriteria: 2,
      leader: l3,
      capUsd: 50,
      remainingUsd: 0,
      backoffDelays: [1],
    } as never);
    expect(l3.generate).toHaveBeenCalled();
    expect(handoff.usedFallback).toBe(false);
  });

  it("the phase planner calls the leader with zero remaining spend", async () => {
    const l = leader();
    await generatePhasePlan({
      projectContext: { context: {}, prefillSource: {}, version: 1 } as never,
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A"], scope: "s", rawQA: [] } as never,
      manifest: { idea: "x", doneThreshold: 0.9, createdAt: new Date() } as never,
      leader: l,
      capUsd: 50,
      remainingUsd: 0,
      backoffDelays: [1],
    } as never);
    expect(l.generate).toHaveBeenCalled();
  });

  it("a standup still runs after three earlier standups (no per-run standup cap)", async () => {
    const flowDir = path.join(os.tmpdir(), `standup-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", "r"), { recursive: true });
    await fs.writeFile(path.join(flowDir, "runs", "r", "state.md"), "## Standup Count\n\n3\n");
    const l = leader();
    const out = await runStandup({
      flowDir,
      runId: "r",
      leader: l,
      capUsd: 50,
      remainingUsd: 0,
      backoffDelays: [1],
    } as never);
    expect(l.generate).toHaveBeenCalled();
    expect(out).not.toBeNull();
  });
});

describe("A — phase spend records carry measurement only", () => {
  it("no capUsd / hintUsd / warnedOverBudget in the persisted record", async () => {
    const flowDir = path.join(os.tmpdir(), `phase-spend-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", "r"), { recursive: true });
    const marker = await recordPhaseStart({ flowDir, runId: "r", phase: "research", sessionId: undefined });
    // capUsd is required by the pre-change signature; ignored once the cap is gone.
    await recordPhaseEnd({ flowDir, runId: "r", marker, capUsd: 50 } as never);
    const state = await fs.readFile(path.join(flowDir, "runs", "r", "state.md"), "utf8");
    expect(state).not.toMatch(/capUsd|hintUsd|warnedOverBudget/);
  });
});

describe("A — cost preview shows an estimate, not a cap", () => {
  it("never mentions a cap or tells the user to shrink the run to fit a budget", () => {
    // capUsd/maxSprints are required by the pre-change signature; ignored once the cap is gone.
    const text = formatCostPreview(
      previewRunCost({ sessionModelId: getTestModels().balanced, capUsd: 50, maxSprints: 8 } as never),
    );
    expect(text).not.toMatch(/\bcap\b/i);
    expect(text).not.toMatch(/--max-cost|fit (the )?budget/i);
  });
});

describe("B — product-loop context byte caps", () => {
  it("the sprint context keeps the whole phase history", () => {
    const phaseHistory = Array.from({ length: 200 }, (_, i) => ({
      phaseId: `phase-${i}`,
      exitedAtUtc: "2026-09-11T00:00:00Z",
      exitSummary: `summary ${i} ${"y".repeat(200)}`,
      sprintsExecuted: 1,
      criteriaMetCount: 1,
    }));
    const ctx = buildSprintContext({
      projectContextFormatted: "## Project",
      customerDecisions: [],
      phaseHistory,
      currentPhase: { id: "p", goal: "g", successCriteria: ["A"], scope: "s" } as never,
      phaseDigest: [],
      sprintTail: "",
    });
    expect(ctx).toContain("phase-0 ");
    expect(ctx).toContain("phase-199 ");
    expect(ctx).not.toMatch(/truncated/);
  });

  it("the phase digest is never pruned", () => {
    let digest: Array<{ sprintN: number; timestampUtc: string; lessonText: string }> = [];
    for (let i = 0; i < 100; i++) {
      digest = digestSprintIntoPhase(digest, { sprintN: i, timestampUtc: "t", lessonText: "z".repeat(400) });
    }
    expect(digest).toHaveLength(100);
  });
});

describe("C — phase sprint loop has no sprint ceiling but ends when nothing progresses", () => {
  let flowDir: string;
  const runId = "r-phase";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `ideal-phase-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    delete process.env.MUONROI_IDEAL_REQUIRE_VERDICT;
  });

  function args(plannedSprints: number, sprintRunner: unknown) {
    return {
      flowDir,
      runId,
      manifest: { idea: "X", doneThreshold: 1, createdAt: new Date() },
      clarifiedSpec: {
        problemStatement: "p",
        constraints: [],
        successCriteria: ["A", "B", "C"],
        scope: "s",
        rawQA: [],
      },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            version: 1,
            generatedAt: "2026-09-11T00:00:00Z",
            phases: [
              {
                id: "phase-1",
                name: "n",
                goal: "g",
                successCriteria: ["A", "B", "C"],
                scope: "s",
                exitCondition: { type: "criteria-threshold", min: 1 },
                dependsOn: [],
                maxSprints: plannedSprints,
              },
            ],
          }),
          costUsd: 0,
        }),
      },
      leaderModelId: "m1",
      // Required by the pre-change signature; ignored once spend gates are gone.
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async () => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1],
      sprintRunner,
    };
  }

  it("keeps running sprints past the planner's estimate while criteria keep being met", async () => {
    let met = 0;
    const sprintRunner = vi.fn(async function* () {
      met += 1;
      yield { type: "info", content: "" };
      return { scoreBefore: 0, scoreAfter: met / 3, criteriaMet: met, totalCriteria: 3 };
    });
    const { value } = await drain(runPhases(args(1, sprintRunner) as never));
    expect(sprintRunner).toHaveBeenCalledTimes(3);
    expect(value.pass).toBe(true);
  });

  it("stops after two consecutive sprints that change nothing, even with a generous plan", async () => {
    const sprintRunner = vi.fn(async function* () {
      yield { type: "info", content: "" };
      return { scoreBefore: 0, scoreAfter: 0, criteriaMet: 0, totalCriteria: 3 };
    });
    const { value } = await drain(runPhases(args(50, sprintRunner) as never));
    expect(sprintRunner).toHaveBeenCalledTimes(2);
    expect(value.pass).toBe(false);
  });
});

describe("C — legacy sprint loop progress tracker", () => {
  it("never stops while sprints improve; stops on the second consecutive sprint with no improvement", async () => {
    const { createSprintProgressTracker } = await import("../sprint-progress.js");
    const t = createSprintProgressTracker();
    for (let i = 1; i <= 40; i++) expect(t.record({ criteriaMet: i, scoreAfter: i / 40 }).stop).toBe(false);
    expect(t.record({ criteriaMet: 40, scoreAfter: 1 }).stop).toBe(false);
    expect(t.record({ criteriaMet: 40, scoreAfter: 1 }).stop).toBe(true);
  });
});

describe("C — plan-adherence review rounds", () => {
  const diffs = () => {
    let n = 0;
    return () => `diff --git a/x b/x\n+change ${n++}`;
  };

  it("runs past the old 2-round default (and the old 4-round clamp) while each round changes the deviations", async () => {
    let reviews = 0;
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviews += 1;
        return reviews < 7
          ? {
              success: true,
              output: JSON.stringify({ adherent: false, deviations: [{ where: `f${reviews}`, issue: "i", fix: "f" }] }),
            }
          : { success: true, output: '{"adherent": true, "deviations": []}' };
      }
      return { success: true, output: "fixed" };
    };
    const { value } = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader",
        fixModelId: "fixer",
        runIsolatedTask,
        diffProvider: diffs(),
      }),
    );
    expect(value.adherent).toBe(true);
    expect(value.rounds).toBe(7);
  });

  it("stops when a fix round leaves the same deviations behind", async () => {
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> =>
      req.description.includes("review")
        ? {
            success: true,
            output: JSON.stringify({ adherent: false, deviations: [{ where: "A.cs", issue: "i", fix: "f" }] }),
          }
        : { success: true, output: "fixed" };
    const { value, chunks } = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader",
        fixModelId: "fixer",
        runIsolatedTask,
        diffProvider: diffs(),
      }),
    );
    expect(value.adherent).toBe(false);
    expect(value.rounds).toBe(2);
    expect(contentOf(chunks)).toMatch(/no progress/i);
  });
});
