import { describe, expect, it } from "vitest";
import {
  aggregateFlowMetrics,
  attributeWorkerCost,
  type FlowMetricsInput,
  type FmCostRow,
  type FmDelegation,
  type FmToolCall,
} from "./flow-metrics-aggregate.js";
import { compareFlowMetrics, formatComparison } from "./flow-metrics-compare.js";

const CWD = "D:\\repo";
const T = (h: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, 0) + h * 3_600_000).toISOString();
const TS = (h: number) => Date.parse(T(h));
const wrap = (inner: unknown) => JSON.stringify({ success: true, output: JSON.stringify(inner) });

function call(name: string, h: number, args: unknown = {}, output: unknown = null, success = true): FmToolCall {
  return {
    sessionId: "root",
    name,
    argsJson: JSON.stringify(args),
    startedAt: T(h),
    success,
    outputJson: output === null ? null : wrap(output),
  };
}

function deleg(over: Partial<FmDelegation> & { id: string }): FmDelegation {
  return {
    parentSessionId: "root",
    agent: "general",
    kind: "task",
    status: "complete",
    startedAt: T(1),
    completedAt: T(1.5),
    hasCouncil: false,
    hasPlanReview: false,
    hasPlanRevalidation: false,
    hasReviewOf: false,
    writes: [],
    ...over,
  };
}

function fixture(over: Partial<FlowMetricsInput> = {}): FlowMetricsInput {
  return {
    sessionId: "root",
    cwd: CWD,
    sessions: [
      { id: "root", parentSessionId: null, kind: "conversation", createdAt: T(0) },
      { id: "child", parentSessionId: "root", kind: "subagent", createdAt: T(5) },
    ],
    firstHumanMessageAt: T(0),
    lastAssistantAt: T(20),
    humanPrompts: 3,
    internalWakeups: 7,
    // plan-gate: starts at 0 and 2; preflight: starts at 6; implementation: starts at 12.
    turns: [
      { endAt: T(1), durationMs: 3_600_000 },
      { endAt: T(3), durationMs: 1_800_000 },
      { endAt: T(7), durationMs: 3_600_000 },
      { endAt: T(13), durationMs: 7_200_000 },
    ],
    toolCalls: [
      call("delegation_read", 1),
      call("delegation_read", 1.1),
      call("delegation_ack", 1.2),
      call("context_load", 1.3),
      call("task", 1.4),
      call("delegate", 1.5),
      call("read_file", 1.6),
      call("flow_plan_review", 2, { action: "start" }, { ok: true, pending: true }),
      call(
        "flow_plan_review",
        3,
        { action: "complete" },
        { ok: false, code: "plan_review_refused", message: "stale_plan_review: changed" },
      ),
      call("flow_plan_review", 4, { action: "complete" }, { completedJobId: "c1", review: { verdict: "revise" } }),
      call(
        "flow_plan_review",
        5,
        { action: "complete" },
        { completedJobId: "c2", review: { verdict: "pass" }, planVerified: true },
      ),
      // The orchestrator itself writes an implementation file at h=12.
      call("write_file", 12, { file_path: "src/App/Main.cs", content: "x" }),
      // A failed write does not count.
      call("write_file", 11, { file_path: "src/App/Early.cs", content: "x" }, null, false),
    ],
    usageEvents: [
      {
        sessionId: "root",
        source: "message",
        model: "m-main",
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 400,
        costMicros: 2_000_000,
        createdAt: T(1),
      },
      {
        sessionId: "root",
        source: "compaction",
        model: "m-small",
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 0,
        costMicros: 100_000,
        createdAt: T(8),
      },
    ],
    compactions: [
      { sessionId: "root", tokensBefore: 120_000, createdAt: T(8) },
      { sessionId: "child", tokensBefore: 90_000, createdAt: T(9) },
    ],
    callAccounting: [
      { stage: "main", estInputTokens: 1000, system: 600, history: 300, toolResults: 100, throwHit: false },
      { stage: "main", estInputTokens: 3000, system: 600, history: 300, toolResults: 100, throwHit: false },
    ],
    delegations: [
      deleg({
        id: "council1",
        agent: "council",
        kind: "council",
        hasCouncil: true,
        hasPlanReview: true,
        councilVerdict: "revise",
      }),
      deleg({ id: "council2", agent: "council", kind: "council", hasCouncil: true, councilVerdict: null }),
      deleg({
        id: "reval",
        agent: "verify",
        kind: undefined,
        hasPlanReview: true,
        hasPlanRevalidation: true,
        hasReviewOf: true,
        revalidationVerdict: "pass",
      }),
      deleg({ id: "survey", agent: "explore", kind: undefined, startedAt: T(2), completedAt: T(3) }),
      deleg({
        id: "planfix",
        startedAt: T(3),
        completedAt: T(3.25),
        writes: [{ tool: "edit_file", path: `${CWD}\\.muonroi-flow\\planning\\PLAN.md`, success: true, at: T(3.1) }],
      }),
      deleg({
        id: "scanner",
        startedAt: T(6),
        completedAt: T(7),
        status: "error",
        error: "worker_incomplete: final answer reached the output limit; configuredOutputTokens=16384",
        writes: [{ tool: "write_file", path: `${CWD}\\src\\App\\notes\\scan.py`, success: true, at: T(6.5) }],
      }),
      deleg({
        id: "impl",
        startedAt: T(9),
        completedAt: T(11),
        writes: [
          { tool: "write_file", path: `${CWD}\\src\\App\\Engine.cs`, success: true, at: T(10) },
          { tool: "edit_file", path: `${CWD}\\src\\App\\Blocked.cs`, success: false, at: T(9.5) },
        ],
      }),
      deleg({ id: "gate", startedAt: T(14), completedAt: T(15), status: "cancelled", error: "Cancelled by user." }),
      deleg({ id: "rev", agent: "verify", startedAt: T(16), completedAt: T(16.5) }),
    ],
    costRows: [],
    usageEventsInRange: [],
    foreignWindows: [],
    ...over,
  };
}

describe("aggregateFlowMetrics", () => {
  const r = aggregateFlowMetrics(fixture());

  it("times the request against the first successful implementation write across main + workers", () => {
    expect(r.timing.firstImplementationWriteAt).toBe(T(10)); // worker write beats main write at h=12
    expect(r.timing.firstImplementationPath).toBe(`${CWD}\\src\\App\\Engine.cs`);
    expect(r.timing.hoursToFirstImplementationWrite).toBeCloseTo(10);
    expect(r.timing.firstFileWriteAt).toBe(T(3.1)); // the PLAN.md edit
    expect(r.timing.planVerifiedAt).toBe(T(5));
    expect(r.timing.hoursToPlanVerified).toBeCloseTo(5);
    expect(r.timing.hoursToFinalAnswer).toBeCloseTo(20);
    expect(r.timing.humanPrompts).toBe(3);
    expect(r.timing.internalWakeups).toBe(7);
    expect(r.sessions.map((s) => s.id)).toEqual(["root", "child"]);
  });

  it("splits orchestrator turn time by the phase each turn started in", () => {
    expect(r.activeHours.planGate).toBeCloseTo(1.5);
    expect(r.activeHours.preflight).toBeCloseTo(1);
    expect(r.activeHours.implementation).toBeCloseTo(2);
    expect(r.activeHours.total).toBeCloseTo(4.5);
  });

  it("counts delegations by structural purpose", () => {
    const counts = Object.fromEntries(Object.entries(r.delegations.byPurpose).map(([k, v]) => [k, v.count]));
    expect(counts).toEqual({
      implementation: 1,
      "impl-support": 1,
      "plan-edit": 1,
      council: 2,
      "plan-review": 1,
      review: 1,
      preflight: 2, // survey + scanner (its .py lives under notes/, before the first impl write)
      other: 0,
    });
    expect(r.delegations.total).toBe(9);
    expect(r.delegations.byPurpose.council.pct).toBeCloseTo((2 / 9) * 100);
    expect(r.delegations.byPurpose.implementation.workerHours).toBeCloseTo(2);
    expect(r.delegations.dispatchToolCalls).toBe(2);
  });

  it("tallies plan-review rounds, refusals and verdicts", () => {
    expect(r.planReview.calls).toBe(4);
    expect(r.planReview.byAction).toEqual({ start: 1, complete: 3 });
    expect(r.planReview.byOutcome).toEqual({ dispatched: 1, refused: 1, completed: 2 });
    expect(r.planReview.refusalReasons).toEqual({ stale_plan_review: 1 });
    expect(r.planReview.recordedVerdicts).toEqual({ revise: 1, pass: 1 });
    expect(r.planReview.councilJobs).toBe(2);
    expect(r.planReview.councilVerdicts).toEqual({ revise: 1, "no-structured-verdict": 1 });
    expect(r.planReview.revalidationJobs).toBe(1);
    expect(r.planReview.revalidationVerdicts).toEqual({ pass: 1 });
  });

  it("counts bookkeeping tools against all orchestrator tool calls", () => {
    expect(r.bookkeeping.byTool).toEqual({ delegation_read: 2, delegation_ack: 1, context_load: 1 });
    expect(r.bookkeeping.total).toBe(4);
    expect(r.bookkeeping.totalToolCalls).toBe(13);
  });

  it("reports worker outcomes with failure categories", () => {
    expect(r.workers).toMatchObject({ total: 9, complete: 7, failed: 1, cancelled: 1 });
    expect(r.workers.byFailureCategory).toEqual({ "output-limit": 1, cancelled: 1 });
    expect(r.workers.failurePct).toBeCloseTo((2 / 9) * 100);
  });

  it("sums compactions across the chain", () => {
    expect(r.compactions).toEqual({ count: 2, tokensBeforeTotal: 210_000, tokensBeforeMax: 120_000 });
  });

  it("totals orchestrator usage and call_accounting segments", () => {
    expect(r.cost.orchestrator.costUsd).toBeCloseTo(2.1);
    expect(r.cost.orchestrator.inputTokens).toBe(1500);
    expect(r.cost.orchestrator.cacheReadPct).toBeCloseTo((400 / 1500) * 100);
    expect(r.cost.orchestrator.bySource.message?.cacheReadPct).toBeCloseTo(40);
    expect(r.cost.callAccounting.main).toMatchObject({ calls: 2, estInputTokens: 4000, peakEst: 3000 });
    expect(r.cost.callAccounting.main?.sysPct).toBeCloseTo(60);
  });

  it("flags a final answer after implementation with no recorded verify pass", () => {
    expect(r.completion.flowVerifyCalls).toBe(0);
    expect(r.completion.finalAnswerAfterImplementationWithoutRecordedPass).toBe(true);
  });

  it("clears the flag once flow_verify recorded a pass, and judges structured completion claims", () => {
    const base = fixture();
    const claim = (h: number, error?: string) =>
      call(
        "context_load",
        h,
        { topic: "working_set", action: "update", root_status: "complete" },
        error ? { error } : { revision: 2 },
      );
    const withVerify = aggregateFlowMetrics(
      fixture({
        toolCalls: [
          ...base.toolCalls,
          claim(13), // accepted before any pass
          claim(14, 'Refused root_status="complete"'), // refused by the host gate
          call("flow_verify", 15, { passed: false }, { ok: true, passed: false }),
          call("flow_verify", 16, { passed: true, evidence: "tests" }, { ok: true, passed: true }),
          claim(17), // accepted after a recorded pass
        ],
      }),
    );
    expect(withVerify.completion).toEqual({
      flowVerifyCalls: 2,
      flowVerifyPasses: 1,
      flowVerifyFails: 1,
      structuredCompleteClaims: 3,
      refusedCompleteClaims: 1,
      acceptedCompleteClaimsWithoutRecordedPass: 1,
      finalAnswerAfterImplementationWithoutRecordedPass: false,
    });
  });

  it("leaves the flag n/a when nothing was implemented", () => {
    const none = aggregateFlowMetrics(fixture({ delegations: [], toolCalls: [] }));
    expect(none.timing.firstImplementationWriteAt).toBeNull();
    expect(none.completion.finalAnswerAfterImplementationWithoutRecordedPass).toBeNull();
    expect(none.activeHours.planGate).toBeCloseTo(4.5); // no boundaries reached
  });

  it("narrows implementation with implExtensions", () => {
    const csprojOnly = aggregateFlowMetrics(fixture({ implExtensions: ["csproj"] }));
    expect(csprojOnly.timing.firstImplementationWriteAt).toBeNull();
  });
});

describe("attributeWorkerCost", () => {
  const row = (over: Partial<FmCostRow>): FmCostRow => ({
    ts: TS(10),
    model: "m-worker",
    callsite: "orchestrator.task",
    usd: 1,
    inputTokens: 100,
    cachedInputTokens: 50,
    outputTokens: 10,
    ...over,
  });
  const own = [{ parentSessionId: "root", start: TS(9), end: TS(11) }];
  const foreign = [{ parentSessionId: "other", start: TS(10.4), end: TS(10.6) }];
  const ids = new Set(["root", "child"]);

  it("drops main-process rows, collapses double-logged compactions and attributes the rest", () => {
    const rows = [
      row({ ts: TS(10), model: "m-main", inputTokens: 1000 }), // billed in usage_events
      row({ ts: TS(10.1), callsite: "orchestrator.compaction", model: "m-small", inputTokens: 500, outputTokens: 5 }),
      row({ ts: TS(10.15), callsite: "orchestrator.compaction", model: "m-small", inputTokens: 500, outputTokens: 5 }),
      row({ ts: TS(10.2), usd: 2 }), // worker, in own window only
      row({ ts: TS(10.5), usd: 4 }), // in own AND foreign window
      row({ ts: TS(12), usd: 8 }), // outside every window
      row({ ts: TS(20), usd: 16, parentSessionId: "child" }), // tagged, ours
      row({ ts: TS(20), usd: 32, parentSessionId: "other" }), // tagged, not ours
    ];
    const usage = [
      { model: "m-main", inputTokens: 1000, createdAt: T(10.05) },
      { model: "m-small", inputTokens: 500, createdAt: T(10.15) },
    ];
    const out = attributeWorkerCost(rows, usage, ids, own, foreign);
    expect(out.rows.map((r) => r.usd)).toEqual([2, 16]);
    expect(out.windowRows).toBe(1);
    expect(out.exactRows).toBe(1);
    expect(out.ambiguousRows).toBe(1);
    expect(out.ambiguousUsd).toBe(4);
    expect(out.duplicateCompactionRows).toBe(1);
  });

  it("does not let one usage event absorb two distinct calls", () => {
    const rows = [row({ ts: TS(10), inputTokens: 7 }), row({ ts: TS(10.01), inputTokens: 7 })];
    const out = attributeWorkerCost(rows, [{ model: "m-worker", inputTokens: 7, createdAt: T(10) }], ids, own, []);
    expect(out.rows).toHaveLength(1);
  });

  it("feeds the report's worker totals", () => {
    const r = aggregateFlowMetrics(
      fixture({
        costRows: [row({ ts: TS(10.2), usd: 2, inputTokens: 100, cachedInputTokens: 25 })],
        delegations: [deleg({ id: "impl", startedAt: T(9), completedAt: T(11) })],
      }),
    );
    expect(r.cost.workers.costUsd).toBe(2);
    expect(r.cost.workers.cacheReadPct).toBeCloseTo(25);
    expect(r.cost.workers.byCallsite["orchestrator.task"]?.calls).toBe(1);
    expect(r.cost.workers.attribution.windowRows).toBe(1);
  });
});

describe("compareFlowMetrics", () => {
  it("lines up baseline and replay with numeric deltas", () => {
    const baseline = aggregateFlowMetrics(fixture());
    const replay = aggregateFlowMetrics(fixture({ delegations: [], toolCalls: [], compactions: [] }));
    const rows = compareFlowMetrics(baseline, replay);
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
    expect(byMetric.delegations).toMatchObject({ baseline: 9, replay: 0, delta: -9 });
    expect(byMetric.compactions?.delta).toBe(-2);
    expect(byMetric["hours to first implementation write"]).toMatchObject({ replay: null, delta: null });
    expect(byMetric["final answer w/o recorded verify pass"]).toMatchObject({ baseline: "yes", replay: "n/a" });
    const text = formatComparison(rows);
    expect(text.split("\n")[0]).toContain("baseline");
    expect(text).toContain("-9");
  });
});
