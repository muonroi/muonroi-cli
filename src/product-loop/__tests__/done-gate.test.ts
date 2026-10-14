import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../types/index.js";
import { evaluateDoneGate } from "../done-gate.js";
import type { DoneGateContext, RoleSlot } from "../types.js";
import { VERIFY_PASS_MARKER } from "../verify-result.js";

describe("evaluateDoneGate", () => {
  let ctx: DoneGateContext;
  let mockLlm: any;
  let mockRespondToPreflight: any;

  beforeEach(() => {
    mockLlm = {
      generate: vi.fn().mockResolvedValue("SHIP"),
    };
    mockRespondToPreflight = vi.fn().mockResolvedValue(true);

    const roleAssignments = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
    roleAssignments.set("PO", { modelId: "gpt-4", provider: "openai", tier: "pro" });
    roleAssignments.set("Customer", { modelId: "claude-3", provider: "anthropic", tier: "pro" });

    ctx = {
      recipe: {
        testCommands: ["npm test"],
        coverage: 0.8,
        ecosystem: "node",
      } as any,
      lastVerify: {
        success: true,
        output: VERIFY_PASS_MARKER,
      } as ToolResult,
      criteria: [{ id: "feat-1", status: "met", evidence: "src/feat1.ts:10" }],
      history: [],
      roleAssignments,
      llm: mockLlm,
      respondToPreflight: mockRespondToPreflight,
      doneThreshold: 0.9,
    };
  });

  it("passes happy path (all 5 conditions)", async () => {
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBe(1.0);
  });

  // F2 — the gate used to re-derive the verdict by re-parsing `lastVerify`,
  // which is the verify sub-agent's raw narration. That parse cannot see the
  // deterministic verify floor, which runs AFTER it in sprint-runner, so a
  // sprint the floor had upgraded on real exit codes still scored
  // `engineering_floor` here and the upgrade was inert.
  it("honours an ALREADY-ADJUDICATED verdict over re-parsing the raw narration", async () => {
    ctx.lastVerify = { success: true, output: "narration with no verdict marker at all" } as ToolResult;

    const withoutVerdict = await evaluateDoneGate({ ...ctx });
    expect(withoutVerdict.failedCondition).toBe("engineering_floor");
    expect(withoutVerdict.reason).toBe("verify_FAIL");

    const withVerdict = await evaluateDoneGate({ ...ctx, verifyVerdict: "PASS" });
    expect(withVerdict.pass).toBe(true);
  });

  it("an adjudicated non-PASS still fails the floor even when the narration says VERIFY_PASS", async () => {
    // The downgrade direction: the floor contradicted a claimed PASS, and the
    // gate must not read the claim back out of the same string.
    const verdict = await evaluateDoneGate({ ...ctx, verifyVerdict: "FAIL" });
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("verify_FAIL");
  });

  it("fails Cond #1: engineering_floor (no recipe)", async () => {
    ctx.recipe = null;
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("no_recipe");
  });

  it("fails Cond #1: engineering_floor (zero coverage) — only when the zero was MEASURED", async () => {
    // A bare `coverage = 0` used to be enough. It is not any more: this gate now
    // fails only on a zero the verify floor actually parsed from the project's own
    // test output (`coverageSource: "measured"`). A number a model typed into a
    // recipe field is not a measurement, and a silent per-sprint score of 0 that
    // repeats forever is too invisible a consequence to hang on one.
    // Definition: src/product-loop/coverage-signal.ts. CB-3 deliberately keeps the
    // broader rule — see zero-coverage-floor.test.ts for the divergence table.
    if (ctx.recipe) {
      ctx.recipe.coverage = 0;
      ctx.recipe.coverageSource = "measured";
    }
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("zero_coverage");
  });

  it("does NOT fail Cond #1 on an unprovenanced zero", async () => {
    if (ctx.recipe) ctx.recipe.coverage = 0;
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.reason).not.toBe("zero_coverage");
  });

  it("fails Cond #1: engineering_floor (verify FAIL)", async () => {
    ctx.lastVerify = { success: false, output: "FAIL" };
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("verify_FAIL");
  });

  it("fails Cond #2: evidence_regex (missing evidence)", async () => {
    ctx.criteria[0].evidence = "we did it"; // invalid evidence
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("evidence_regex");
    expect(verdict.reason).toContain("missing_evidence");
  });

  it("fails Cond #3: weighted_score (below threshold)", async () => {
    ctx.criteria = [{ id: "feat-1", status: "partial", evidence: "src/feat1.ts:10" }]; // score 0.5
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("weighted_score");
    expect(verdict.score).toBe(0.5);
  });

  it("fails Cond #4: customer_debate (echo_chamber)", async () => {
    ctx.roleAssignments.set("Customer", { modelId: "gpt-4", provider: "openai", tier: "pro" });
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("customer_debate");
    expect(verdict.reason).toBe("echo_chamber");
  });

  it("fails Cond #4: customer_debate (dissent)", async () => {
    mockLlm.generate
      .mockResolvedValueOnce("PO explanation")
      .mockResolvedValueOnce("Customer doubt")
      .mockResolvedValueOnce("WAIT: some bug");
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("customer_debate");
    expect(verdict.reason).toBe("some bug");
  });

  it("skips Cond #4: customer_debate when MUONROI_DEV=1", async () => {
    process.env.MUONROI_DEV = "1";
    ctx.roleAssignments.set("Customer", { modelId: "gpt-4", provider: "openai", tier: "pro" }); // normally would fail echo_chamber
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(true); // Should pass because debate is skipped
    delete process.env.MUONROI_DEV;
  });

  it("skips Cond #4: customer_debate when score < 0.85 (R5 skip)", async () => {
    ctx.criteria = [
      { id: "f1", status: "met", evidence: "f.ts:1" },
      { id: "f2", status: "met", evidence: "f.ts:2" },
      { id: "f3", status: "met", evidence: "f.ts:3" },
      { id: "f4", status: "met", evidence: "f.ts:4" },
      { id: "f5", status: "met", evidence: "f.ts:5" },
      { id: "f6", status: "partial", evidence: "f.ts:6" }, // score = 5.5 / 6 = 0.916
    ];
    ctx.doneThreshold = 0.7; // Lower threshold to pass Cond #3

    // Now make it < 0.85
    ctx.criteria.push({ id: "f7", status: "unmet" }); // score = 5.5 / 7 = 0.785

    ctx.roleAssignments.set("Customer", { modelId: "gpt-4", provider: "openai", tier: "pro" }); // echo_chamber if debate runs

    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(true); // Should pass because debate is skipped (score 0.785 < 0.85)
  });

  it("fails Cond #5: user_approval (rejection)", async () => {
    mockRespondToPreflight.mockResolvedValue(false);
    const verdict = await evaluateDoneGate(ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("user_approval");
  });
});
